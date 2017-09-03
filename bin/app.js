const os = require('os');
const fs = require('fs');
const chalk = require('chalk');
const path = require('path');
const commander = require('commander');
const indentString = require('indent-string');
const table = require('text-table');
const _ = require('underscore');

const GithubWalker = require('../lib/github-walker.js');

const header = `
      ___                                                   ___           ___     
     /$__$                                   _____         /$__$         /$  $    
    /:/ _/_                     ___         /::$  $       /:/ _/_       /::$  $   
   /:/ /$  $                   /$__$       /:/$:$  $     /:/ /$__$     /:/$:$__$  
  /:/ /::$  $   ___     ___   /:/__/      /:/  $:$__$   /:/ /:/ _/_   /:/ /:/  /  
 /:/_/:/$:$__$ /$  $   /$__$ /::$  $     /:/__/ $:|__| /:/_/:/ /$__$ /:/_/:/__/___
 $:$/:/ /:/  / $:$  $ /:/  / $/$:$  $__  $:$  $ /:/  / $:$/:/ /:/  / $:$/:::::/  /
  $::/ /:/  /   $:$  /:/  /   ~~$:$/$__$  $:$  /:/  /   $::/_/:/  /   $::/~~/~~~~ 
   $/_/:/  /     $:$/:/  /       $::/  /   $:$/:/  /     $:$/:/  /     $:$~~$     
     /:/  /       $::/  /        /:/  /     $::/  /       $::/  /       $:$__$    
     $/__/         $/__/         $/__/       $/__/         $/__/         $/__/    
`;

console.log(chalk.blue(header.replace(/\$/gi, '\\')));

function createDirectoryIfMissing(directoryPath) {
  if (!fs.existsSync(directoryPath)) {
    fs.mkdirSync(directoryPath);
  }
}

// TODO(jmcgill): Move working path to application state.
function initialize() {
  createDirectoryIfMissing(path.join(os.homedir(), '.slider'));
}

function printDiff(preamble, diff) {
  if (diff.diff) {
    const parts = diff.diff.split('\n');
    for (const part of parts) {
      if (part.startsWith('+')) {
        console.log(preamble, chalk.green(part));
      } else if (part.startsWith('-')) {
        console.log(preamble, chalk.red(part));
      } else {
        console.log(preamble, part);
      }
    }
  } else if (diff.renamed_file) {
    const renamedDiff = indentString(
      `Renamed ${diff.a_path} to ${diff.b_path}`,
      8,
    );
    console.log(chalk.yellow(renamedDiff));
  }
}

function printDiffs(status) {
  _.each(status, (value, key) => {
    // Deletions and renames have a null-key
    if (key === 0) {
      console.log('    ', chalk.magenta.bold(value.a_path));
    } else {
      console.log('    ', chalk.magenta.bold(key));
    }
    printDiff('       ', value);
  });
}

// const config = {
//   options: {
//     id: 'test14',
//     commitMessage: 'Update the contents of the JAMES file',
//     reviewTitle: `Update the contents of the JAMES file. This brings us into compliance
// with James law`,
//   },
//
//   fn: function ls(root) {
//     fs.writeFileSync(
//       path.join(root, 'JAMES'),
//       'I have updated the JAMES file, pray I do not update it again.',
//     );
//
//     return {
//       complex: 10,
//       object: 11,
//     };
//   },
//
//   reviewers() {
//     return ['plexer'];
//   },
// };

const config = {
  options: {
    id: 'jimmy/rename-owners',
    commitMessage: 'Rename OWNERS to CODEOWNERS',
    reviewTitle:
      'Rename OWNERS to CODEOWNERS to allow us to require reviews by OWNERS',
  },

  fn: function ls(root) {
    if (fs.existsSync(path.join(root, 'OWNERS'))) {
      fs.renameSync(path.join(root, 'OWNERS'), path.join(root, 'CODEOWNERS'));
      return true;
    }
    return false;
  },

  reviewers(root) {
    if (fs.existsSync(path.join(root, 'CODEOWNERS'))) {
      const text = fs.readFileSync(path.join(root, 'CODEOWNERS'), 'utf-8');

      const owners = text.split('\n');
      if (owners.length > 0) {
        return [owners[0]];
      }
    }

    return ['plexer'];
  },

  reduce(memo, value) {
    return value ? (memo || 0) + 1 : memo || 0;
  },
};

(async function main() {
  initialize();

  commander
    .version('0.1.0')
    .option('-e, --expression', 'Expression')
    .option('-d, --dryrun', 'Dry run')
    .parse(process.argv);

  // Read our github token.
  const tokenPath = path.join(process.env.HOME, '.githubcreds');

  if (!fs.existsSync(tokenPath)) {
    console.log(
      'You must download a Github user token and store it in ~/.githubcreds.',
    );
    process.exit();
  }

  const token = fs.readFileSync(tokenPath, 'utf-8').trim();

  const walker = new GithubWalker(
    token,
    /.*/,
    path.join(os.homedir(), '.slider'),
    config,
    commander.dryrun,
  );
  const r = await walker.walk({
    organization: 'button',
  });

  _.each(r, (value, url) => {
    console.log(chalk.blue.bold(url));
    printDiffs(value.status);
    console.log('\n');

    console.log('    ', chalk.magenta.bold('Reviewers'));
    if (value.reviewers && value.reviewers.length > 0) {
      console.log(indentString(value.reviewers.join(', '), 8));
    } else {
      console.log(indentString('NONE', 8));
    }
    console.log('\n');

    console.log('    ', chalk.magenta.bold('Slider Output'));
    console.log(indentString(JSON.stringify(value.operationResult), 8));
    console.log('\n');
  });

  // Print status table
  const rows = [];
  _.each(r, (value, url) => {
    let status = chalk.green('COMPLETE');
    if (value.mergeResult) {
      status = chalk.green('MERGED');
    } else if (commander.dryrun) {
      status = chalk.yellow('DRY RUN');
    } else if (value.reviewers.length === 0) {
      status = chalk.red('NO REVIEWERS FOUND');
    } else if (value.hasPendingComments) {
      status = chalk.yellow('AWAITING REPLY FROM YOU');
    } else if (value.pullRequest) {
      status = chalk.red('PENDING REVIEW');
    }
    let pullRequestUrl = '';
    if (value.pullRequest) {
      pullRequestUrl = value.pullRequest.url;
    }

    rows.push([chalk.blue(url), status, pullRequestUrl]);
  });

  console.log(table(rows));

  // Reduce operation results
  const reducedResult = _.reduce(
    r,
    (memo, value) => config.reduce(memo, value.operationResult),
    null,
  );
  console.log('\n');
  console.log(chalk.blue('Reduced:'), reducedResult);
})();
