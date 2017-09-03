// Abstracts the local management of a Git repository, for the set of operations used for
// clean batch edits.

const gift = require('gift');
const bluebird = require('bluebird');
const fs = require('fs');
const log = require('js-logging').colorConsole();
const path = require('path');
const _ = require('underscore');

function repositoryNameFromSshUrl(url) {
  return url.split('/')[1].replace('.git', '');
}

class Repository {
  constructor(url, workingDir) {
    this.url = url;
    this.workingDir = workingDir;
  }

  // Sync master to origin/master, resetting any local changes made.
  async init() {
    // Do we have a local copy of this repository on disk?
    if (!fs.existsSync(this.path())) {
      await bluebird
        .promisifyAll(gift)
        .cloneAsync(this.url, this.path(), 5, null);
    }
    this.repo = bluebird.promisifyAll(gift(this.path()));

    await this.repo.remote_fetchAsync('origin');
    await this.repo.checkoutAsync('master');
    await this.repo.resetAsync('origin/master', { hard: true });
  }

  path() {
    return path.join(this.workingDir, repositoryNameFromSshUrl(this.url));
  }

  // Commit the specified branch if changes have been made relative to master.
  async commit(branchName, message) {
    log.info('Commiting changes on current branch');

    const status = await this.statusToRemoteMaster();
    if (status.length === 0) {
      return;
      // await this.repo.resetAsync(branchName, { hard: true });
    }

    log.error('Local modifications made -- committing');
    await this.repo.checkoutAsync(branchName);

    // TODO(jimmy): Provide a better message here.
    await this.repo.commitAsync(message, { all: true });
  }

  async statusToRemoteMaster() {
    await this.repo.addAsync('.');
    return this.repo.diffAsync('origin/master', '', {
      'ignore-all-space': true,
    });
  }

  // Return true if a particular local branch exists
  async branchExists(name) {
    const branches = await this.repo.branchesAsync();

    // Create the branch if it does not already exist.
    return _.findIndex(branches, branch => branch.name === name) !== -1;
  }

  // Create a new local branch if it does not yet exist.
  async branch(name) {
    log.info(`Creating a new remote/local branch: ${name}`);
    if (!await this.branchExists(name)) {
      log.debug('Local branch not found - creating now');
      await this.repo.create_branchAsync(name);
    }

    await this.repo.checkoutAsync(name);
  }

  async pushToRemote(name) {
    await this.repo.remote_pushAsync('origin', name, { f: true });
  }

  async deleteBranch(name) {
    log.info(`Deleting an existing remote/local branch: ${name}`);
    if (!await this.branchExists(name)) {
      return;
    }
    await this.repo.delete_branchAsync(name, true);
  }
}

module.exports = Repository;
