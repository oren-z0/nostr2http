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
    .requiredOption(
      '--relays <relays...>',
      'A list of relays to use for the nostr direct-messages.',
    )
    .requiredOption(
      '--nsec-file <filename>',
      'Listen to nostr messages to this nsec.',
    )
    .option('--timeout <timeout>', 'Timeout in milliseconds', 300000)
    .option('--response-manipulator <filename>', 'A script that can change the response before the nostr message is sent.')
    .option('-v, --verbose', 'Verbose logs')
    .argument('<destination>', 'Destination url prefix (i.e. http://localhost:8080/subroute)')
    .parse();

  runServer(program.args[0], program.opts());
}

