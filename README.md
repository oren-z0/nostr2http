# nostr2http
A simple http reverse-proxy that forwards nostr direct-messages as http requests.

**This package is very useful together with [http2nostr](https://github.com/oren-z0/http2nostr)
for accessing http servers that run in different local networks (behind
[NAT](https://en.wikipedia.org/wiki/Network_address_translation)).**

Execute directly with npx: `npx nostr2http <destination> [options]`.
Alternatively, you can install nostr2http globally with: `npm i -g nostr2http`, and then run
`nostr2http <destination> [options]` directly.
This proxy only accepts HTTP requests to the detination server - the url of the HTTP request must
be a path that begins with '/', and cannot be a complete url as used in general-purpose proxies
(see: https://developer.mozilla.org/en-US/docs/Web/HTTP/Messages)

For example:
```
npx nostr2http https://api.thecatapi.com --nsec-file ~/my-nsec.txt --save-nsec --relays wss://relay.damus.io wss://nos.lol wss://relay.snort.social wss://nostr.wine --allowed-routes '/v1/images/**'
```

```
$ npx nostr2http --help

Usage: nostr2http [options] <destination>

A simple http proxy that forwards all requests as nostr direct-messages.

Arguments:
  destination                             Destination url prefix (i.e. http://localhost:8080/subroute)

Options:
  -V, --version                           output the version number
  --relays <relays...>                    A list of relays to use for the nostr direct-messages.
  --relays-file <filename>                A file to read the relays from. If both --relays and --relays-file are defined and the file exists, only the file will be used.
                                          If the file doesn't exist or empty, it will be created with the relays given in the --relays option (i.e. the --relays option
                                          represents "default relays" in this case). The relays in the file should be separated by space or new-lines.
  --nsec-file <filename>                  Listen to nostr messages to this nsec.
  --save-nsec                             If the nsec file was not found, generate a random nsec and save it in the same path.
  --save-npub-file <filename>             Save the npub of used nsec. Useful for other processes to read it.
  --timeout <timeout>                     Timeout in milliseconds (default: 300000)
  --response-manipulator-file <filename>  A script that can change the response before the nostr message is sent.
  --allowed-routes <patterns...>          A list of route patterns to allow (see: https://www.npmjs.com/package/minimatch). To disallow a pattern, add a '!' prefix. For
                                          complex rewrites and redirects we recommend installing a separated reverse-proxy.
  --nprofile-max-relays                   Max number of relays to include in the printed NIP-19 nprofile entity
  --exit-on-file-change                   Exit when the files in --relays-file, --nsec-file or --response-manipulator-file change by an external process. Useful to reboot
                                          the server when those configuration change (don't forget to start the process again after it dies, using docker-compose
                                          configuration or some other way).
  -v, --verbose                           Verbose logs
  -h, --help                              display help for command
```
