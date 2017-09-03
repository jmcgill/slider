// GithubWalker walks a set of repositories and applies an operation to each repository that matches a supplied regex.

const GithubApi = require("github");
const Promise = require('bluebird');
const log = require('js-logging').colorConsole();
const u = require('underscore');

var Repository = require('./repository.js');

var token = 'b90ff5307161b8ce52955d724d737ce20d203f38';

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

    _walkUser() {
        var _ = this;
        log.debug('Walking repositories for the current user');

        this.github.authenticate({
            type: "oauth",
            token: token
        });

        // TODO(jmcgill): Break this into a separate class for a single repository so that it is safe to store
        // the repository state in the class.
        return this.github.repos.getAll({})
            .then(function(res) {
                var promises = [];
                for (var repo of res.data) {
                    var promise = _._applyOperationToRepository(repo.ssh_url, repo.name, repo.owner.login);
                    if (promise) {
                        promises.push(promise);
                    }
                }

                return Promise.all(promises);
            }).then(function (data) {
                return u.reduce(data, function(memo, e) {
                    return u.extend(memo, e);
                });
            });
    }

    _title() {
        if (this._cachedTitle) {
            return this._cachedTitle;
        }
        this._cachedTitle = (this.operation.options.title || ("Bulk Change " + Math.floor(Math.random() * 1000)));
        return this._cachedTitle;
    }

    _branchName() {
        var title = this._title();
        return 'slider/' + this.operation.options.id;
    }

    // Github has a gnarly bug when merging PRs that have recently been modified.
    _attemptMerge(owner, name, pullRequestNumber) {
        return this.github.pullRequests.merge({
            owner: owner,
            repo: name,
            number: pullRequestNumber
        }).catch(function (error) {
            console.log('*** GOT ERROR: Error');
        });
    }

    _createOrRefreshPullRequest(name, owner) {
        var _ = this;
        return _.github.users.get({}).then(function (user) {
            log.debug('Querying pull requests');
            return _.github.pullRequests.getAll({
                owner: owner,
                repo: name,
                head: user.data.login + ':' + _._branchName()
            });
        }).then(function (existingRequests) {
            // Does there already exist a pull request?
            if (existingRequests.data.length > 0) {
                log.info('Pull request already exists - not creating new one.');
                // Do not create a new pull request. Possibly update the pull request?
                return existingRequests.data[0];
            }

            log.info('Creating new pull request.');
            return _.github.pullRequests.create({
                owner: owner,
                title: _._title(),
                repo: name,
                head: _._branchName(),
                base: 'master'
            });
        });
    }

    _addReviewers(prChain, name, owner, repository) {
        var _ = this;

        var reviewers = _.operation.reviewers(repository.path());
        var pullRequestNumber = null;

        return prChain.then(function (pullRequest) {
            pullRequestNumber = pullRequest.number || pullRequest.data.number;
            return _.github.pullRequests.getReviewRequests({
                owner: owner,
                repo: name,
                number: pullRequestNumber
            });
        }).then(function (reviewsRequested) {
            var currentReviewers = {};
            for (var i = 0; i < reviewsRequested.data.users.length; ++i) {
                var user = reviewsRequested.data.users[i];
                currentReviewers[user.login] = true;
            }

            var newReviewers = [];
            for (var i = 0; i < reviewers.length; ++i) {
                // The user is not already listed as a reviewer.
                if (!currentReviewers[reviewers[i]]) {
                    newReviewers.push(reviewers[i]);
                }
            }

            if (newReviewers.length == 0) {
                log.info('No new reviewers to add');
                return;
            }

            log.info('Adding new reviewers: ' + newReviewers.join(', '));

            return _.github.pullRequests.createReviewRequest({
                owner: owner,
                repo: name,
                number: pullRequestNumber,
                reviewers: newReviewers
            });
        });
    }

    _mergeIfApproved(prChain, name, owner) {
        var _ = this;
        var prNumber;
        return prChain.then(function (pullRequest) {
            log.info('Fetching reviews');
            // HACK
            prNumber = pullRequest.number || pullRequest.data.number;
            return _.github.pullRequests.getReviews({
                number: pullRequest.number || pullRequest.data.number,
                owner: owner,
                repo: name
            });
        }).then(function (reviews) {
            let approved = false;
            for (var i = 0; i < reviews.data.length; ++i) {
                let review = reviews.data[i];
                if (review.state == 'APPROVED') {
                    approved = true;
                }
            }

            if (!approved) {
                return;
            }

            const parts = reviews.data[0].pull_request_url.split('/');
            var pullRequestNumber = parts[parts.length - 1];

            if (approved) {
                log.info('Pull Request approved - merging into master')
                return _._attemptMerge(owner, name, pullRequestNumber);
            }
        });
    }

    _applyOperationToRepository(sshUrl, name, owner) {
        log.debug('Visiting ' + sshUrl);
        var _ = this;

        if (!this.pattern.exec(sshUrl)) {
            return;
        }

        log.debug('Operating on ' + sshUrl);
        var repository = new Repository(sshUrl, this.workingDir);

        // Apply the operation to each repository, saving the result of the operation.
        var a = repository.init().then(function() {
            return repository.deleteBranch(_._branchName());
        }).then(function() {
            // Create branch if required.
            log.info('Branching to named branch');
            return repository.branch(_._branchName());
        }).then(function(path) {
            log.info('Applying operation to repository');
            // Apply the operation to the master branch.
            return _.operation.fn(repository.path());
        });

        var b = a.then(function() {
            log.info('Commiting changes');
            return repository.commit(_._branchName());
        }).then(function() {
            log.info('Pushing to remote');
            return repository.pushToRemote(_._branchName());
        });

        // Get the status of the repository after applying the operation.
        var c = b.then(function() {
            log.info('Fetching status');
            return repository.status();
        });

        // Commit the operation and submit a pull request.
        var d = c.then(function(status) {
            if (!status) {
                log.error('No changes relative to master - will not create a PR');
                return null;
            } else {
                var a = _._createOrRefreshPullRequest(name, owner);
                var b = _._addReviewers(a, name, owner, repository);
                var c = _._mergeIfApproved(a, name, owner);

                return Promise.join(a, b, c, function (pullRequest, reviewers, mergeResult) {
                    console.log('***', pullRequest, reviewers, mergeResult);
                    return {
                        pullRequest: pullRequest,
                        mergeResult: mergeResult
                    };
                });
            }
        });

        return Promise.join(a, c, d, function (result, status, pr) {
            console.log('***** PR IS', pr);

            var r = {};
            r[sshUrl] = {
                result: result,
                status: status,
            };

            // Pull requests are only created if something has changed relative to master.
            if (pr) {
                r[sshUrl].pullRequest = pr.pullRequest;
                r[sshUrl].mergeResult = pr.mergeResult;
            }
            return r;
        }).catch(function(err) {
            log.error('Caught a broken promise chain');
            console.log(err);
        });
    }
}

module.exports = GithubWalker;