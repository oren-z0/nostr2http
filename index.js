#!/usr/bin/env node
const { runServer } = require('./lib/server');

exports.runServer = runServer;

if (require.main === module) {
  const { program } = require('commander');
  const { version } = require('./package');
  program
    .name('http2nostr')
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
    .option('--timeout <timeout>', 'Timeout in milliseconds', 300000)
    .option(
      '--response-manipulator <filename>',
      'A script that can change the response before the nostr message is sent.',
    )
    .option('-v, --verbose', 'Verbose logs')
    .argument('<destination>', 'Destination url prefix (i.e. http://localhost:8080/subroute)')
    .parse();

  runServer(program.args[0], program.opts());
}

