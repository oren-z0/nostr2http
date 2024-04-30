#!/usr/bin/env node
const { runServer } = require('./lib/server');

exports.runServer = runServer;

if (require.main === module) {
  const { program } = require('commander');
  const { version } = require('./package');
  program
    .name('nostr2http')
    .description('A simple http proxy that forwards all requests as nostr direct-messages.')
    .version(version)

  program
    .option(
      '--relays <relays...>',
      'A list of relays to use for the nostr direct-messages.',
    )
    .option(
      '--relays-file <filename>',
      'A file to read the relays from. If both --relays and --relays-file are defined and the file\
 exists, only the file will be used. If the file doesn\'t exist or empty, it will be created with\
 the relays given in the --relays option (i.e. the --relays option represents "default relays" in\
 this case). The relays in the file should be separated by space or new-lines.',
    )
    .requiredOption(
      '--nsec-file <filename>',
      'Listen to nostr messages to this nsec.',
    )
    .option(
      '--save-nsec',
      'If the nsec file was not found, generate a random nsec and save it in the same path.',
    )
    .option(
      '--save-npub-file <filename>',
      'Save the npub of used nsec. Useful for other processes to read it.',
    )
    .option('--timeout <timeout>', 'Timeout in milliseconds', 300000)
    .option(
      '--response-manipulator-file <filename>',
      'A script that can change the response before the nostr message is sent.',
    )
    .option(
      '--allowed-routes <patterns...>',
      'A list of route patterns to allow (see:\
 https://www.npmjs.com/package/minimatch). To disallow a pattern, add a \'!\' prefix. For complex\
 rewrites and redirects we recommend installing a separated reverse-proxy.',
    )
    .option(
      '--nprofile-max-relays',
      'Max number of relays to include in the printed NIP-19 nprofile entity',
      5,
    )
    .option(
      '--exit-on-file-change',
      'Exit when the files in --relays-file, --nsec-file or --response-manipulator-file change\
 by an external process. Useful to reboot the server when those configuration change (don\'t\
 forget to start the process again after it dies, using docker-compose configuration or some\
 other way).',
    )
    .option('-v, --verbose', 'Verbose logs')
    .argument('<destination>', 'Destination url prefix (i.e. http://localhost:8080/subroute)')
    .parse();

  runServer(program.args[0], program.opts());
}

