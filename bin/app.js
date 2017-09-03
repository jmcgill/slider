const os = require('os');
const fs = require('fs');
const chalk = require('chalk');
const path = require('path');
const commander = require('commander');
const log = require('js-logging').colorConsole();
const indentString = require('indent-string');
const table = require('text-table');

const GithubWalker = require('../lib/github-walker.js');

var header = `
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

console.log(chalk.blue(header.replace(/\$/ig, '\\')));

function createDirectoryIfMissing(path) {
    if (!fs.existsSync(path)){
        fs.mkdirSync(path);
    }
}

// TODO(jmcgill): Move working path to application state.
function initialize() {
    createDirectoryIfMissing(path.join(os.homedir(), '.slider'));
}

function printDiff(preamble, diff) {
    var parts = diff.split('\n');
    for (var part of parts) {
        if (part.startsWith('+++')) {
            console.log(preamble, chalk.green(part));
        } else if (part.startsWith('---')) {
            console.log(preamble, chalk.red(part));
        } else {
            console.log(preamble, part)
        }
    }
}

var config = {
    options: {
        id: 'test12'
    },
    fn: function ls(root) {
        log.info('Running ls function on: ', root);
        // Create a new owners file
        fs.writeFileSync(path.join(root, 'JAMES'), 'this is a new file');

        return 5;
    },
    reviewers: function(root) {
        return ["plexer"]
    }
};

(function main() {
    initialize();

    // var image = fs.readFileSync('/Users/jmcgill/slider.png');
    // console.png(image);

    commander.version('0.1.0')
        .option('-e, --expression', 'Expression')
        .option('-d, --dryrun', 'Dry run')
        .parse(process.argv);

    var walker = new GithubWalker(/short/, path.join(os.homedir(), '.slider'), config);
    walker.walk({
        user: "jmcgill"
    }).then(function (r) {
        for (var url in r) {
            console.log(chalk.blue.bold(url));
            for (var diff in r[url].status) {
                console.log('    ', chalk.magenta.bold(diff));
                printDiff('       ', r[url].status[diff]);
            }
            console.log('\n');
            console.log('    ', chalk.magenta.bold('Slider Output'));
            console.log(indentString(JSON.stringify(r[url].result), 8));
            console.log('\n');
        }


        // Print status table
        var rows = [];
        for (var url in r) {
            var status = chalk.green('COMPLETE');
            if (r[url].pullRequest) {
                status = chalk.red('PENDING REVIEW');
            }

            var pullRequestUrl = '';
            if (r[url].pullRequest) {
                pullRequestUrl = r[url].pullRequest.url;
            }

            rows.push([chalk.blue(url), status, pullRequestUrl]);
        }

        console.log(table(rows));
    });
})();