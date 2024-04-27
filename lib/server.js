const http = require('node:http');
const https = require('node:https');
const fs = require('node:fs');
const {
  Client, Filter, Timestamp, nip04Decrypt, NostrSigner, Keys,
  loadWasmAsync, EventBuilder, RelayListItem,
} = require("@rust-nostr/nostr-sdk");
const { Minimatch } = require('minimatch');

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

function writeFile(filename, payload) {
  const dirname = path.dirname(filename);
  if (!fs.existsSync(dirname)) {
    fs.mkdirSync(dirname);
  }
  fs.writeFileSync(filename, payload);
}

function readWriteKeys({ nsecFile, saveNsec }) {
  if (fs.existsSync(nsecFile)) {
    return Keys.parse(fs.readFileSync(nsecFile).toString().trim());
  }
  if (!saveNsec) {
    throw new Error("nsec-file not found");
  }
  const keys = Keys.generate();
  console.info("Saving nsec-file");
  writeFile(nsecFile, keys.secretKey.toBech32());
  return keys;
}

function readWriteRelays({ relays, relaysFile }) {
  if (relaysFile && fs.existsSync(relaysFile)) {
    const relaysFromFile = fs.readFileSync(relaysFile).toString().split(/\s+/).filter(Boolean);
    if (relaysFromFile.length > 0) {
      return relaysFromFile;
    }
  }
  // Support both an array of relays or a single string of relays separated by spaces.
  const relaysFromOption = relays ? [].concat(...relays.map(r => r.split(' '))) : [];
  if (relaysFromOption.length === 0) {
    throw new Error(
      "Missing --relays option, or a --relays-file option that points to a non-empty file",
    );
  }
  if (relaysFile) {
    writeFile(relaysFile, relaysFromOption.join('\n'));
  }
  return relaysFromOption;
}

async function getResponse(
  parsedContent,
  { logPrefix, requestModule, destination, positiveMinimatchers, negativeMinimatchers, timeout },
) {
  try {
    const isRouteAllowed = (parsedContent.url[0] === '/') && (
      positiveMinimatchers === undefined ||
      positiveMinimatchers.some(m => m.match(parsedContent.url))
    ) && !negativeMinimatchers.some(m => m.match(parsedContent.url));
    if (!isRouteAllowed) {
      console.warn(`${logPrefix}: Forbidden route`);
      return {
        status: 403,
        headers: {},
        bodyBuffer: Buffer.from("Forbidden route"),
      }
    }
    return await new Promise((resolve, reject) => {
      const httpRequest = requestModule.request(
        destination + parsedContent.url,
        {
          timeout,
          method: parsedContent.method,
          headers: parsedContent.headers,
        },
        (res) => {
          const responseChunks = [];
          res.on('data', (chunk) => {
            responseChunks.push(chunk);
          });
          res.on('end', () => resolve({
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
    return {
      status: 500,
      headers: {},
      bodyBuffer: Buffer.from("Request failed"),
    };
  }
}

exports.runServer = async function runServer(destination, options) {
  const verboseLog = options.verbose ? ((t) => console.info(t)) : () => {};
  verboseLog("Loading WebAssembly");
  await loadWasmAsync();

  const keys = readWriteKeys(options);

  const positiveMinimatchers = (
    options.allowedRoutes
    ? options.allowedRoutes.filter(r => r[0] !== '!').map(
      r => new Minimatch(r, { dot: true, platform: 'darwin' })
    )
    : undefined
  );
  const negativeMinimatchers = (
    options.allowedRoutes
    ? options.allowedRoutes.filter(r => r[0] === '!').map(
      r => new Minimatch(r.slice(1), { dot: true, platform: 'darwin' })
    )
    : []
  );

  const client = new Client(NostrSigner.keys(keys));
  // Support both an array of relays or a single string of relays separated by spaces.
  const relays = readWriteRelays(options);
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
        if (!url || typeof url !== 'string') {
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
        } ${JSON.stringify(parsedContent.method)} ${JSON.stringify(parsedContent.url)}`,
      );
      const responseMessage = await getResponse(parsedContent, {
        logPrefix,
        requestModule,
        destination,
        positiveMinimatchers,
        negativeMinimatchers,
        timeout: Number(options.timeout),
      });
      try {
        // TODO: manipulate responseMessage
        const { bodyBuffer, ...other } = responseMessage;
        const stringifiedResponseMessage = JSON.stringify({
          bodyBase64: bodyBuffer.toString('base64'),
          ...other,
          id: parsedContent.id,
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
  if (options.exitOnFileChange) {
    if (options.nsecFile) {
      fs.watchFile(options.nsecFile, () => {
        console.info("Exiting due to nsec-file change:", options.nsecFile);
        process.exit(0);
      });
    }
    if (options.relaysFile) {
      fs.watchFile(options.relaysFile, () => {
        console.info("Exiting due to relays-file change:", options.relaysFile);
        process.exit(0);
      });
    }
    if (options.responseManipulatorFile) {
      fs.watchFile(options.responseManipulatorFile, () => {
        console.info(
          "Exiting due to response-manipulator-file change:",
          options.responseManipulatorFile,
        );
        process.exit(0);
      });
    }
  }
};
