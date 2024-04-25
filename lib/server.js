const http = require('node:http');
const https = require('node:https');
const fs = require('fs');
const {
  Client, Filter, Timestamp, nip04Decrypt, NostrSigner, Keys,
  loadWasmAsync, EventBuilder, RelayListItem,
} = require("@rust-nostr/nostr-sdk");

function getRequestModule(url) {
    const urlLowerCase = url.toLowerCase();
    if (urlLowerCase.startsWith('http://')) {
        return http;
    }
    if (urlLowerCase.startsWith('https://')) {
        return https;
    }
    throw new Error("Unexpected url protocol: must begin with http:// or https://");
}

exports.runServer = async function runServer(destination, options) {
  const verboseLog = options.verbose ? ((t) => console.info(t)) : () => {};
  verboseLog("Loading WebAssembly");
  await loadWasmAsync();

  const keys = Keys.parse(fs.readFileSync(options.nsecFile).toString().trim());

  const client = new Client(NostrSigner.keys(keys));
  // Support both an array of relays or a single string of relays separated by spaces.
  const relays = [].concat(...options.relays.map(r => r.split(' ')));
  client.addRelays(relays);
  verboseLog("Connecting");
  await client.connect();

  const relaysListEvent = EventBuilder.relayList(
    relays.map(r => new RelayListItem(r)),
  ).toEvent(keys);
  verboseLog("Publishing relays");
  await client.sendEvent(relaysListEvent);

  const requestModule = getRequestModule(destination);

  const filter = new Filter().pubkey(keys.publicKey).kind(4).since(Timestamp.now());

  client.handleNotifications({
    handleEvent: async (relayUrl, subscriptionId, event) => {
      verboseLog(`Event: ${event.asJson()}`);
      if (event.kind !== 4) {
        return;
      }
      let parsedContent;
      try {
        const content = nip04Decrypt(keys.secretKey, event.author, event.content);
        verboseLog(`NIP04 Message: ${content}`);
        parsedContent = JSON.parse(content);
        if (!parsedContent || typeof parsedContent !== 'object') {
          throw new Error("Unexpected content type");
        }
        const { id, headers, method, url, bodyBase64 } = parsedContent;
        if (!id || typeof id !== 'string' || id.length > 100) {
          throw new Error("Unexpected type for field: id");
        }
        if (!url || typeof url !== 'string' || url[0] !== '/') {
          throw new Error("Unexpected type for field: url");
        }
        if (!method || typeof method !== 'string') {
          throw new Error("Unexpected type for field: method");
        }
        if (
          !headers ||
          typeof headers !== 'object' ||
          Object.values(headers).some((v) => typeof v !== 'string')
        ) {
          throw new Error("Unexpected type for field: headers");
        }
        if (typeof bodyBase64 !== 'string') {
          throw new Error("Unexpected type for field: bodyBase64");
        }
      } catch (err) {
        console.error("Impossible to handle DM:", err);
        return;
      }
      const logPrefix = JSON.stringify(parsedContent.id);
      console.info(
        `${logPrefix}: ${
          event.author.toBech32()
        } ${JSON.stringify(parsedContent.method)} ${JSON.stringify(req.url)}`,
      );
      let responseMessage;
      try {
        responseMessage = await new Promise((resolve, reject) => {
          const httpRequest = requestModule.request(
            destination + parsedContent.url,
            {
              timeout: options.timeout,
              method: parsedContent.method,
              headers: parsedContent.headers,
            },
            (res) => {
              const responseChunks = [];
              res.on('data', (chunk) => {
                responseChunks.push(chunk);
              });
              res.on('end', () => resolve({
                id: parsedContent.id,
                status: res.statusCode,
                headers: res.headers,
                bodyBuffer: Buffer.concat(responseChunks),
              }));
            },
          );
          httpRequest.on('error', (err) => reject(err));
          httpRequest.end(Buffer.from(parsedContent.bodyBase64, 'base64'))
        });
      } catch (err) {
        console.error(`${logPrefix}: Request failed:`, err);
        responseMessage = {
          id: parsedContent.id,
          status: 500,
          headers: {},
          bodyBuffer: Buffer.from("Request failed"),
        };
      }
      try {
        // TODO: manipulate responseMessage
        const { bodyBuffer, ...other } = responseMessage;
        const stringifiedResponseMessage = JSON.stringify({
          bodyBase64: bodyBuffer.toString('base64'),
          ...other,
        });
        verboseLog(`${logPrefix}: Sending response: ${stringifiedResponseMessage}`);
        await client.sendDirectMsg(event.author, stringifiedResponseMessage);
        console.info(`${logPrefix}: ${responseMessage.status}`)
      } catch (err) {
        console.error(`${logPrefix}: Failed to send DM reply:`, err);
      }
    },
    handleMsg: async (relayUrl, message) => {}
  })
  await client.subscribe([filter]);
  console.info(`Listening for direct-messages to ${keys.publicKey.toBech32()}`);
};
