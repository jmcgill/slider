// GithubWalker walks a set of repositories and applies an operation to each repository that
// matches a supplied regex.
const GithubApi = require('github');
const Promise = require('bluebird');
const log = require('js-logging').colorConsole();
const _ = require('underscore');

// TODO(jimmy): Migrate to absolute include paths.
const Repository = require('./repository.js');

function timeout(milliseconds) {
  return new Promise(resolve => setTimeout(resolve, milliseconds));
}

class GithubWalker {
  constructor(token, pattern, workingDir, operation, dryRun) {
    this.pattern = pattern;
    this.operation = operation;
    this.github = new GithubApi({});
    this.workingDir = workingDir;
    this.dryRun = dryRun;
    this.token = token;

    const { options } = this.operation;
    if (!options) {
      throw new Error('Options object must be set.');
    }

    if (!options.reviewTitle) {
      throw new Error('options.reviewTitle must be set.');
    }

    if (!operation) {
      throw new Error('An operation must be provided.');
    }
  }

  walk(options) {
    if (options.organization) {
      return this._walkOrganization(options.organization);
    }

    if (options.user) {
      return this._walkUser();
    }

    return null;
  }

  async _walkUser() {
    log.debug('Walking repositories for the current user');

    this.github.authenticate({
      type: 'oauth',
      token: this.token,
    });

    const remoteRepositories = await this.github.repos.getAll({});
    const mergedOutput = {};
    for (const repo of remoteRepositories.data) {
      const output = await this._applyOperationToRepository(
        repo.ssh_url,
        repo.name,
        repo.owner.login,
      );

      if (output) {
        mergedOutput[repo.ssh_url] = output;
      }
    }
    return mergedOutput;
  }

  async _walkOrganization(organization) {
    log.debug('Walking repositories for the the specified organization');

    this.github.authenticate({
      type: 'oauth',
      token: this.token,
    });

    let remoteRepositories = await this.github.repos.getForOrg({
      org: organization,
      per_page: 100,
    });
    let repositories = remoteRepositories.data;
    console.log(this.github.hasNextPage(remoteRepositories));
    while (this.github.hasNextPage(remoteRepositories)) {
      console.log('Loading another page');
      remoteRepositories = await this.github.getNextPage(
        remoteRepositories,
        null,
      );
      repositories = _.union(remoteRepositories.data, repositories);
    }

    const mergedOutput = {};
    for (const repo of repositories) {
      const output = await this._applyOperationToRepository(
        repo.ssh_url,
        repo.name,
        repo.owner.login,
      );

      if (output) {
        mergedOutput[repo.ssh_url] = output;
      }
    }
    return mergedOutput;
  }

  _branchName() {
    return `slider/${this.operation.options.id}`;
  }

  // Github has a gnarly bug when merging PRs that have recently been modified, so we retry
  // multiple times with a delay between each attempt.
  async _attemptMerge(owner, name, pullRequestNumber) {
    let attempts = 0;
    while (attempts < 10) {
      attempts += 1;
      try {
        await this.github.pullRequests.merge({
          owner,
          repo: name,
          number: pullRequestNumber,
        });
        return true;
      } catch (e) {
        // Merge failed. Delay before trying again.
        await timeout(10000);
      }
    }

    // We failed to merge after ten attempts, so this likely was not the Github bug.
    throw new Error(`Failed to merge repository ${name} after 10 attempts.`);
  }

  async _createOrRefreshPullRequest(name, owner, title) {
    const currentUser = await this.github.users.get({});
    const existingPullRequests = await this.github.pullRequests.getAll({
      owner,
      repo: name,
      head: `${currentUser.data.login}:${this._branchName()}`,
    });

    if (existingPullRequests.data.length > 0) {
      log.info('Pull request already exists - not creating new one.');
      return existingPullRequests.data[0];
    }

    log.info('Creating new pull request.');
    const pullRequest = await this.github.pullRequests.create({
      owner,
      title,
      repo: name,
      head: this._branchName(),
      base: 'master',
    });
    return pullRequest.data;
  }

  async _addReviewers(pullRequestNumber, name, owner, repository) {
    const reviewers = this.operation.reviewers(repository.path());
    const reviewsRequested = await this.github.pullRequests.getReviewRequests({
      owner,
      repo: name,
      number: pullRequestNumber,
    });

    const currentReviewers = _.map(
      reviewsRequested.data.users,
      user => user.login,
    );
    const newReviewers = _.difference(reviewers, currentReviewers);

    if (newReviewers.length === 0) {
      log.info('No new reviewers to add');
      return currentReviewers;
    }

    log.info(`Adding new reviewers: ${newReviewers.join(', ')}`);
    await this.github.pullRequests.createReviewRequest({
      owner,
      repo: name,
      number: pullRequestNumber,
      reviewers: newReviewers,
    });
    return _.union(newReviewers, currentReviewers);
  }

  async _hasPendingComments(pullRequestNumber, name, owner) {
    // const currentUser = await this.github.users.get({});
    // const username = currentUser.data.login;

    const reviews = await this.github.pullRequests.getReviews({
      number: pullRequestNumber,
      owner,
      repo: name,
    });

    // TODO(jimmy): The comments API does not appear to be working yet, making it difficult
    // to determine if a change really does need changes. For now we will assume it does unless
    // it is explicitely approved.
    const approved = _.findIndex(
      reviews.data,
      review => review.state === 'APPROVED',
    );

    if (reviews.data.length > 0 && approved === -1) {
      return true;
    }

    return false;
  }

  async _mergeIfApproved(pullRequestNumber, name, owner) {
    const reviews = await this.github.pullRequests.getReviews({
      number: pullRequestNumber,
      owner,
      repo: name,
    });

    const approved = _.findIndex(
      reviews.data,
      review => review.state === 'APPROVED',
    );
    if (approved === -1) {
      return false;
    }

    log.info('Pull Request approved - merging into master');
    return this._attemptMerge(owner, name, pullRequestNumber);
  }

  async _applyOperationToRepository(sshUrl, name, owner) {
    if (!this.pattern.exec(sshUrl)) {
      return null;
    }

    log.debug(`Applying operation to ${sshUrl}`);
    const repository = new Repository(sshUrl, this.workingDir);

    // During initialization we put this repository into a clean state by syncing to origin/master.
    await repository.init();

    // Delete and re-create any existing named branches to ensure that we always apply from a
    // consistent state that matches the current remote master.
    await repository.deleteBranch(this._branchName());
    await repository.branch(this._branchName());
    const operationResult = await this.operation.fn(repository.path());

    const status = await repository.statusToRemoteMaster();

    // Do not make any changes to the remote master unless we need to.
    if (this.dryRun || status.length === 0) {
      return {
        operationResult,
        status,
        reviewers: this.operation.reviewers(repository.path()),
      };
    }

    // Commit our changes (if any) and push to the remote origin to prepare for review.
    const defaultMessage =
      'Committing a bulk modification using github.com/jmcgill/slider';
    const message = this.operation.options.commitMessage || defaultMessage;
    await repository.commit(this._branchName(), message);
    await repository.pushToRemote(this._branchName());

    // Manage the process of creating pull requests and waiting for approval.
    const { reviewTitle } = this.operation.options;
    const pullRequest = await this._createOrRefreshPullRequest(
      name,
      owner,
      reviewTitle,
    );

    const pullRequestNumber = pullRequest.number;
    const reviewers = await this._addReviewers(
      pullRequestNumber,
      name,
      owner,
      repository,
    );
    const mergeResult = await this._mergeIfApproved(
      pullRequestNumber,
      name,
      owner,
    );
    const hasPendingComments = await this._hasPendingComments(
      pullRequestNumber,
      name,
      owner,
    );

    return {
      operationResult,
      status,
      pullRequest,
      mergeResult,
      reviewers,
      hasPendingComments,
    };
  }
}

module.exports = GithubWalker;
