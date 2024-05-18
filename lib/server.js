const http = require('node:http');
const https = require('node:https');
const fs = require('node:fs');
const path = require('node:path');
const process = require('node:process');
const { setTimeout: sleep } = require('node:timers/promises');
const {
  Client, Filter, Timestamp, nip04Decrypt, NostrSigner, Keys, loadWasmAsync,
  Nip19Profile,
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
    fs.mkdirSync(dirname, { recursive: true });
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
    // Return relays from file even if it is empty.
    return fs.readFileSync(relaysFile).toString().split(/\s+/).filter(Boolean);
  }
  // Support both an array of relays or a single string of relays separated by spaces.
  const relaysFromOption = relays ? [].concat(...relays.map(r => r.split(' '))) : [];
  if (relaysFromOption.length === 0) {
    throw new Error(
      "Missing --relays option, or a --relays-file option that points to a file.",
    );
  }
  if (relaysFile) {
    writeFile(relaysFile, relaysFromOption.join('\n'));
  }
  return relaysFromOption;
}

async function getResponse(
  requestMessage,
  {
    logPrefix, requestModule, destination, positiveMinimatchers, negativeMinimatchers, timeout,
    responseManipulatorModule, keys,
  },
) {
  try {
    const isRouteAllowed = (requestMessage.url[0] === '/') && (
      positiveMinimatchers === undefined ||
      positiveMinimatchers.some(m => m.match(requestMessage.url))
    ) && !negativeMinimatchers.some(m => m.match(requestMessage.url));
    if (!isRouteAllowed) {
      console.warn(`${logPrefix}: Forbidden route`);
      return {
        status: 403,
        headers: {},
        bodyBuffer: Buffer.from("Forbidden route"),
      }
    }
    const responseMessage = await new Promise((resolve, reject) => {
      const httpRequest = requestModule.request(
        destination + requestMessage.url,
        {
          timeout,
          method: requestMessage.method,
          headers: requestMessage.headers,
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
      httpRequest.end(Buffer.from(requestMessage.bodyBase64, 'base64'))
    });
    if (!responseManipulatorModule) {
      return responseMessage;
    }
    const newResponseMessage = await responseManipulatorModule({
      requestMessage, responseMessage, keys, destination,
    });
    if (newResponseMessage === undefined) {
      return responseMessage;
    }
    if (!newResponseMessage || typeof newResponseMessage !== 'object') {
      throw new Error("Response manipulator did not return an object.");
    }
    if (Object.keys(newResponseMessage) > 3) {
      throw new Error("Response manipulator returned too many fields.");
    }
    if (typeof newResponseMessage.status !== 'number') {
      throw new Error(
        "Response manipulator must return an object with a status field of type number.",
      );
    }
    if (
      !newResponseMessage.headers ||
      typeof newResponseMessage.headers !== 'object' ||
      Object.values(newResponseMessage.headers).some(h => typeof h !== 'string')
    ) {
      throw new Error("Response manipulator returned an unexpected headers field.");
    }
    if (!Buffer.isBuffer(newResponseMessage.bodyBuffer)) {
      throw new Error(
        "Response manipulator must return an object with a bodyBuffer field of type Buffer.",
      );
    }
    return newResponseMessage;
  } catch (err) {
    console.error(`${logPrefix}: Request failed:`, err);
    return {
      status: 500,
      headers: {},
      bodyBuffer: Buffer.from("Request failed"),
    };
  }
}

async function getRelaysStatuses(client) {
  const allRelays = await client.relays();
  return await Promise.all(
    allRelays.map(async (relay) => ({
      relay: relay.url(),
      isConnected: await relay.isConnected(),
    })),
  );
}

exports.runServer = async function runServer(destination, options) {
  const verboseLog = options.verbose ? ((t) => console.info(t)) : () => {};
  verboseLog("Loading WebAssembly");
  await loadWasmAsync();

  const keys = readWriteKeys(options);
  if (options.saveNpubFile) {
    console.info("Saving npub-file");
    writeFile(options.saveNpubFile, keys.publicKey.toBech32());
  }

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

  const responseManipulatorModule = options.responseManipulatorFile && require.main.require(
    path.join(process.cwd(), options.responseManipulatorFile),
  );

  // Support both an array of relays or a single string of relays separated by spaces.
  const initalRelayUrls = readWriteRelays(options);
  if (initalRelayUrls.length > 0) {
    const client = new Client(NostrSigner.keys(keys));
    client.addRelays(initalRelayUrls);
    verboseLog("Connecting to relays");
    await client.connect();
    await sleep(1000);
    let relaysStatuses = await getRelaysStatuses(client);
    if (relaysStatuses.every(status => !status.isConnected)) {
      // wait some more
      await sleep(5000);
      relaysStatuses = await getRelaysStatuses(client);
      if (relaysStatuses.every(status => !status.isConnected)) {
        console.error("Failed to connect to any of the relays.");
        throw new Error("Failed to connect to any of the relays.");
      }
    }
    if (options.verbose) {
      console.table(relaysStatuses);
    } else {
      console.info(`Connected to ${
        relaysStatuses.filter(w => w.isConnected).length
      }/${relaysStatuses.length} relays.`);
    }
  
    const requestModule = getRequestModule(destination);
  
    client.handleNotifications({
      handleEvent: async (relayUrl, subscriptionId, event) => {
        verboseLog(`Event: ${event.asJson()}`);
        if (event.kind !== 4) {
          return;
        }
        let requestMessage;
        try {
          const content = nip04Decrypt(keys.secretKey, event.author, event.content);
          verboseLog(`NIP04 Message: ${content}`);
          requestMessage = JSON.parse(content);
          if (!requestMessage || typeof requestMessage !== 'object') {
            throw new Error("Unexpected content type");
          }
          const { id, headers, method, url, bodyBase64 } = requestMessage;
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
        const logPrefix = JSON.stringify(requestMessage.id);
        console.info(
          `${logPrefix}: ${
            event.author.toBech32()
          } ${JSON.stringify(requestMessage.method)} ${JSON.stringify(requestMessage.url)}`,
        );
        let responseMessage = await getResponse(requestMessage, {
          logPrefix,
          requestModule,
          destination,
          positiveMinimatchers,
          negativeMinimatchers,
          timeout: Number(options.timeout),
          responseManipulatorModule,
          keys,
        });
        try {
          const { bodyBuffer, ...other } = responseMessage;
          const stringifiedResponseMessage = JSON.stringify({
            bodyBase64: bodyBuffer.toString('base64'),
            ...other,
            id: requestMessage.id,
          });
          verboseLog(`${logPrefix}: Sending response: ${stringifiedResponseMessage}`);
          await client.sendDirectMsg(event.author, stringifiedResponseMessage);
          console.info(`${logPrefix}: ${responseMessage.status}`)
        } catch (err) {
          console.error(`${logPrefix}: Failed to send DM reply:`, err);
        }
      },
      handleMsg: async (relayUrl, message) => {}
    });
    const filter = new Filter().pubkey(keys.publicKey).kind(4).since(Timestamp.now());
    await client.subscribe([filter]);
    console.info(`Listening for direct-messages to ${keys.publicKey.toBech32()}`);
    const goodRelays = relaysStatuses.filter(
      (w) => w.isConnected).map((w) => w.relay).slice(0, Number(options.nprofileMaxRelays),
    );
    const nprofile = new Nip19Profile(keys.publicKey, goodRelays).toBech32();
    console.info(
      `This entity includes both your public-key and hints for ${
        goodRelays.length
      } of the relays that your are connected to: ${nprofile}`,
    )
    if (options.saveNprofileFile) {
      console.info("Saving nprofile-file");
      writeFile(options.saveNprofileFile, nprofile);
    }
  } else {
    console.info("No relays to connect.");
  }
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
