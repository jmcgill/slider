// Abstracts the local management of a repository.

const gift = require('gift');
const path = require('path');
const bluebird = require('bluebird');
const fs = require('fs');
const log = require('js-logging').colorConsole();
const u = require('underscore');

class Repository {
    // Construct a local instance of a repository. If this repository exists on disk, it is advanced to the latest
    // commit. If it does not exist on disk it is checked out.
    constructor(url, workingDir) {
        this.url = url;
        this.workingDir = workingDir;
    }

    init() {
        var _ = this;

        if (!fs.existsSync(this._localPath())) {
            // TODO(jmcgill): Make this a promise.
            return this._cloneRepository().then(function() {
                _.repo = gift(_._localPath());
                bluebird.promisifyAll(_.repo);
                return _._localPath();
            });
        } else {
            this.repo = gift(this._localPath());
            bluebird.promisifyAll(this.repo);
            return this.repo.remote_fetchAsync('origin')
                .then(function() {
                    return _.repo.checkoutAsync('master');
                }).then(function() {
                    return _.repo.resetAsync('origin/master', {'hard': true});
                }).then(function() {
                    return _.repo.current_commitAsync();
                }).then(function(commit) {
                    // TODO(jmcgill): What do I need the current commit for?
                    return _._localPath();
                });
        }

        // TODO(jmcgill): Hard revert and sync to head.
    }

    // Commit, but only if required.
    commit(branchName) {
        var _ = this;
        log.info('Commiting changes on current branch');

        return _.statusToRemote(branchName).then(function(status) {
            if (status.length == 0) {
                log.error('No modifications - resetting to remote');
                return _.repo.resetAsync(branchName, {'hard': true});
            } else {
                log.error('Local modifications made -- committing');
                return _.repo.checkoutAsync(branchName).then(function() {
                    return _.repo.commitAsync('Commiting bulk modification', {all: true})
                });
            }
        });
    }

    // TODO(jimmy): Can I delete this - statusToRemote seems to be a better version.
    status() {
        var _ = this;

        return this.repo.addAsync('.').then(function() {
            return _.repo.statusAsync();
        }).then(function(status) {
            if (!status.clean) {
                return _.repo.commitAsync('Temporary message Part 2', {all: true})
            }
        }).then(function() {
            return _.repo.diffAsync('origin', 'HEAD')
        }).then(function(diffs) {
            var status = null;
            for (var diff of diffs) {
                if (!status) {
                    status = {};
                }
                status[diff.b_path] = diff.diff;
            }
            return status;
        });
    }

    statusToRemote(remote) {
        var _ = this;
        return this.repo.addAsync('.').then(function() {
            return _.repo.diffAsync('origin/master', '', {'ignore-all-space': true});
        });
    }

    // Branch a repository both locally and remotely.
    branch(name) {
        log.info('Creating a new remote/local branch: ' + name);
        var _ = this;

        // Check whether the branch already exists
        return _.repo.branchesAsync().then(function(branches) {

            // Does this branch already exist?
            var found = false;
            for (var branch of branches) {
                if (branch.name == name) {
                    found = true;
                }
            }

            if (!found) {
                log.debug('Local repository not found - creating now');
                return _.repo.create_branchAsync(name).then(function() {
                    return _.repo.checkoutAsync(name);
                });
            } else {
                return _.repo.checkoutAsync(name);
            }
        })
    }

    pushToRemote(name) {
        return this.repo.remote_pushAsync('origin', name, {"f": true});
    }

    deleteBranch(name) {
        log.info('Deleting an existing remote/local branch: ' + name);
        var _ = this;

        // Check whether the branch already exists
        return _.repo.branchesAsync().then(function(branches) {

            // Does this branch already exist?
            var found = false;
            for (var branch of branches) {
                if (branch.name == name) {
                    found = true;
                }
            }

            if (!found) {
                log.debug('Local repository not found - nothing to delete');
                return;
            } else {
                return _.repo.delete_branchAsync(name, true);
            }
        });
    }

    resetCurrentBranch() {
        var _ = this;
        return this.repo.resetAsync('HEAD^', { hard: true });
    }

    path() {
        var _ = this;
        return _._localPath();
    }

    // Clone the contents of branch a into branch b while preserving branch and commit history.
    // This will completely replace the contents of branch b.
    cloneTo(a, b) {
        var _ = this;

        // return this.repo.checkoutAsync(a).then(function() {
        //     return _.repo.mergeAsync(b, { strategy: 'ours' });
        // }).then(function() {
        //     return _.repo.checkoutAsync(b);
        // }).then(function() {
        //     return _.repo.mergeAsync(a);
        // });
    }

    _repositoryNameFromSshUrl(url) {
        return url.split('/')[1].replace('.git', '');
    }

    _localPath() {
        return path.join(this.workingDir, this._repositoryNameFromSshUrl(this.url));
    }

    _cloneRepository() {
        var _ = this;
        log.error('$$$');
        var localPath = this._localPath();
        log.error(localPath);

        return new Promise(function (resolve, reject) {
            // Create a shallow clone, since we really only need to
            gift.clone(_.url, localPath, 5, null, function (err, repository) {
                if (err) {
                    reject(err);
                }

                log.debug('Cloned repository', localPath);
                _.repository = repository;
                resolve(localPath);
            });
        });
    }
}

module.exports = Repository;