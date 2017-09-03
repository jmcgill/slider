// GithubWalker walks a set of repositories and applies an operation to each repository that matches a supplied regex.
const GithubApi = require("github");
const Promise = require('bluebird');
const log = require('js-logging').colorConsole();
const _ = require('underscore');

// TODO(jimmy): Migrate to absolute include paths.
var Repository = require('./repository.js');

// TODO(jimmy): Move to a secrets configuration file.
var token = 'b90ff5307161b8ce52955d724d737ce20d203f38';

const timeout = (milliseconds) => {
    new Promise(resolve => setTimeout(resolve, milliseconds))
};

class GithubWalker {
    constructor(pattern, workingDir, operation) {
        this.pattern = pattern;
        this.operation = operation;
        this.github = new GithubApi({});
        this.workingDir = workingDir;
    }

    walk(options) {
        if (options.organization) {
            return this._walkOrganization();
        }

        if (options.user) {
            return this._walkUser();
        }
    }

    async _walkUser() {
        var _ = this;
        log.debug('Walking repositories for the current user');

        this.github.authenticate({
            type: "oauth",
            token: token
        });

        remoteRepositories = await github.repos.getAll({});
        var mergedStatus = {};
        for (var repo of res.data) {
            var status = this._applyOperationToRepository(repo.ssh_url, repo.name, repo.owner.login);
            _.extend(mergedStatus, status);

        }
    }

    _title() {
        if (this._cachedTitle) {
            return this._cachedTitle;
        }
        this._cachedTitle = (this.operation.options.title || ("Bulk Change " + Math.floor(Math.random() * 1000)));
        return this._cachedTitle;
    }

    _branchName() {
        return 'slider/' + this.operation.options.id;
    }

    // Github has a gnarly bug when merging PRs that have recently been modified, so we retry multiple times with
    // a delay between each attempt.
    async _attemptMerge(owner, name, pullRequestNumber) {
        let attempts = 0;
        let mergeSucceeded = false;
        while (!mergeSucceeded && ++attempts < 10) {
            try {
                await this.github.pullRequests.merge({
                    owner: owner,
                    repo: name,
                    number: pullRequestNumber
                });
                mergeSucceded = true;
            } catch () {
                // Merge failed. Delay before trying again.
                await timeout(10000);
            }
        }

        // We failed to merge after ten attempts, so this likely was not the Github bug.
        if (attempts == 10) {
            throw new Error(`Failed to merge repository ${name} after 10 attempts.`)
        }
    }

    async _createOrRefreshPullRequest(name, owner) {
        let currentUser = await this.github.users.get({});
        let existingPullRequests = await this.github.pullRequests.getAll({
            owner: owner,
            repo: name,
            head: currentUser.data.login + ':' + this._branchName()
        });

        if (existingPullRequests.data.length > 0) {
            log.info('Pull request already exists - not creating new one.');
            return existingPullRequests.data[0];
        }

        log.info('Creating new pull request.');
        return await this.github.pullRequests.create({
            owner: owner,
            title: this._title(),
            repo: name,
            head: this._branchName(),
            base: 'master'
        }).data;
    }

    async _addReviewers(pullRequestNumber, name, owner, repository) {
        const reviewers = this.operation.reviewers(repository.path());
        let reviewsRequested = await this.github.pullRequests.getReviewRequests({
            owner: owner,
            repo: name,
            number: pullRequestNumber
        });

        const currentReviewers = _.map(reviewsRequested.data.users, user => user.login);
        const newReviewers = _.difference(currentReviewers, reviewers);

        if (newReviewers.length === 0) {
            log.info('No new reviewers to add');
            return;
        }

        log.info('Adding new reviewers: ' + newReviewers.join(', '));
        return await this.github.pullRequests.createReviewRequest({
            owner: owner,
            repo: name,
            number: pullRequestNumber,
            reviewers: newReviewers
        });
    }

    async _mergeIfApproved(pullRequestNumber, name, owner) {
        const reviews = await this.github.pullRequests.getReviews({
            number: pullRequest.number || pullRequest.data.number,
            owner: owner,
            repo: name
        });

        let approved = _.findIndex(reviews.data, review => review.state === 'APPROVED');
        if (approved == -1) {
            return;
        }

        log.info('Pull Request approved - merging into master');
        return await this._attemptMerge(owner, name, pullRequestNumber);
    }

    async _applyOperationToRepository(sshUrl, name, owner) {
        if (!this.pattern.exec(sshUrl)) {
            return;
        }

        log.debug('Applying operation to ' + sshUrl);
        const repository = new Repository(sshUrl, this.workingDir);

        // Delete and re-create any existing named branches to ensure that we always apply from a consistent state that
        // matches the current remote master.
        await repository.deleteBranch(this._branchName());
        await repository.branch(this._branchName());
        const operationResult = await this.operation.fn(repository.path());

        // Commit our changes (if any) and push to the remote origin to prepare for review.
        await repository.commit(this._branchName());
        await repository.pushToRemote(this._branchName());

        // TODO(jimmy): Is this needed anymore?
        const status = await repository.status();

        // Mange the process of creating pull requests and waiting for approval.
        // TODO(jimmy): Consider splitting this out into a different provider class so that multiple hosts could
        // be better supported.
        const pullRequest = await this._createOrRefreshPullRequest(name, owner);
        const pullRequestNumber = pullRequest.number;
        await this._addReviewers(pullRequestNumber, name, owner, repository);
        const mergeResult = await this._mergeIfApproved(pullRequestNumber, name, owner);

        let r = {};
        r[sshUrl] = {
            result: operationResult,
            status: status,
            pullRequest: pullRequest,
            mergeResult: mergeResult
        }
    }
}

module.exports = GithubWalker;