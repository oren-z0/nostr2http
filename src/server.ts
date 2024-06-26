import * as http from 'node:http';
import * as https from 'node:https';
import {existsSync, readFileSync, writeFileSync, watchFile, mkdirSync, StatWatcher, unwatchFile} from 'node:fs';
import * as path from 'node:path';
import {randomInt} from 'node:crypto';
import {setTimeout as sleep} from 'node:timers/promises';
import {
  nip19,
  nip44,
  generateSecretKey,
  getPublicKey,
  Event as NostrEvent,
  UnsignedEvent,
  verifyEvent,
  finalizeEvent,
  getEventHash,
} from 'nostr-tools';
import {SimplePool, useWebSocketImplementation} from 'nostr-tools/pool';
import {WebSocket} from 'ws';
import {Minimatch} from 'minimatch';
import {normalizeURL} from 'nostr-tools/utils';

const EphemeralGiftWrapKind = 21059;
const SealKind = 13;
const HttpRequestKind = 80;
const HttpResponseKind = 81;

type RequestModule = typeof http | typeof https;

function getRequestModule(url: string): RequestModule {
  const urlLowerCase = url.toLowerCase();
  if (urlLowerCase.startsWith('http://')) {
    return http;
  }
  if (urlLowerCase.startsWith('https://')) {
    return https;
  }
  throw new Error('Unexpected url protocol: must begin with http:// or https://');
}

function writeFile(filename: string, payload: string): void {
  const dirname = path.dirname(filename);
  if (!existsSync(dirname)) {
    mkdirSync(dirname, {recursive: true});
  }
  writeFileSync(filename, payload);
}

interface ReadWriteSecretKeyOptions {
  nsecFile: string;
  saveNsec?: boolean;
}

function readWriteSecretKey({nsecFile, saveNsec}: ReadWriteSecretKeyOptions): Uint8Array {
  if (existsSync(nsecFile)) {
    const existingSecretKey = nip19.decode(readFileSync(nsecFile).toString().trim());
    if (existingSecretKey.type !== 'nsec') {
      throw new Error('Unexpected private key format');
    }
    return existingSecretKey.data;
  }
  if (!saveNsec) {
    throw new Error('nsec-file not found');
  }
  const secretKey = generateSecretKey();
  console.info('Saving nsec-file');
  writeFile(nsecFile, nip19.nsecEncode(secretKey));
  return secretKey;
}

interface ReadWriteRelaysOptions {
  relays?: string[];
  relaysFile?: string;
}

function readWriteRelays({relays, relaysFile}: ReadWriteRelaysOptions): string[] {
  if (relaysFile && existsSync(relaysFile)) {
    // Return relays from file even if it is empty.
    return readFileSync(relaysFile).toString().split(/\s+/).filter(Boolean);
  }
  // Support both an array of relays or a single string of relays separated by spaces.
  const relaysSplit = relays?.map(r => r.split(' '));
  const relaysFromOption = relaysSplit ? ([] as string[]).concat(...relaysSplit) : [];
  if (relaysFromOption.length === 0) {
    throw new Error('Missing --relays option, or a --relays-file option that points to a file.');
  }
  if (relaysFile) {
    writeFile(relaysFile, relaysFromOption.join('\n'));
  }
  return relaysFromOption;
}

interface RequestMessage {
  id: string;
  url: string;
  method: string;
  headers: Record<string, string>;
  bodyBase64: string;
}

interface ResponseMessage {
  status: number;
  headers: Record<string, string>;
  bodyBuffer: Buffer;
}

interface ResponseManipulatorOptions {
  requestMessage: RequestMessage;
  responseMessage: ResponseMessage;
  secretKey: Uint8Array;
  destination: string;
  nprofile: string;
}

interface ResponseManipulatorModule {
  default: (options: ResponseManipulatorOptions) => ResponseMessage;
}

interface GetResponseOptions {
  logPrefix: string;
  requestModule: RequestModule;
  destination: string;
  positiveMinimatchers?: Minimatch[];
  negativeMinimatchers: Minimatch[];
  timeout: number;
  responseManipulatorModule?: ResponseManipulatorModule;
  secretKey: Uint8Array;
  nprofile: string;
}

async function getResponse(
  requestMessage: RequestMessage,
  {
    logPrefix,
    requestModule,
    destination,
    positiveMinimatchers,
    negativeMinimatchers,
    timeout,
    responseManipulatorModule,
    secretKey,
    nprofile,
  }: GetResponseOptions
): Promise<ResponseMessage> {
  try {
    const isRouteAllowed =
      requestMessage.url[0] === '/' &&
      (positiveMinimatchers === undefined || positiveMinimatchers.some(m => m.match(requestMessage.url))) &&
      !negativeMinimatchers.some(m => m.match(requestMessage.url));
    if (!isRouteAllowed) {
      console.warn(`${logPrefix}: Forbidden route`);
      return {
        status: 403,
        headers: {},
        bodyBuffer: Buffer.from('Forbidden route'),
      };
    }
    const responseMessage = await new Promise<ResponseMessage>((resolve, reject) => {
      const httpRequest = requestModule.request(
        destination + requestMessage.url,
        {
          timeout,
          method: requestMessage.method,
          headers: requestMessage.headers,
        },
        res => {
          const responseChunks: Buffer[] = [];
          res.on('data', chunk => {
            responseChunks.push(chunk);
          });
          res.on('end', () =>
            resolve({
              status: res.statusCode ?? 500,
              headers: Object.fromEntries(
                Object.entries(res.headers).map(([headerName, headerValue]) => [
                  headerName,
                  Array.isArray(headerValue) ? headerValue[0] : headerValue ?? '',
                ])
              ),
              bodyBuffer: Buffer.concat(responseChunks),
            })
          );
        }
      );
      httpRequest.on('error', err => reject(err));
      httpRequest.end(Buffer.from(requestMessage.bodyBase64, 'base64'));
    });
    if (!responseManipulatorModule) {
      return responseMessage;
    }
    const newResponseMessage = await responseManipulatorModule.default({
      requestMessage,
      responseMessage,
      secretKey,
      destination,
      nprofile,
    });
    if (newResponseMessage === undefined) {
      return responseMessage;
    }
    if (!newResponseMessage || typeof newResponseMessage !== 'object') {
      throw new Error('Response manipulator did not return an object.');
    }
    if (Object.keys(newResponseMessage).length > 3) {
      throw new Error('Response manipulator returned too many fields.');
    }
    if (typeof newResponseMessage.status !== 'number') {
      throw new Error('Response manipulator must return an object with a status field of type number.');
    }
    if (
      !newResponseMessage.headers ||
      typeof newResponseMessage.headers !== 'object' ||
      Object.values(newResponseMessage.headers).some(h => typeof h !== 'string')
    ) {
      throw new Error('Response manipulator returned an unexpected headers field.');
    }
    if (!Buffer.isBuffer(newResponseMessage.bodyBuffer)) {
      throw new Error('Response manipulator must return an object with a bodyBuffer field of type Buffer.');
    }
    return newResponseMessage;
  } catch (err) {
    console.error(`${logPrefix}: Request failed:`, err);
    return {
      status: 500,
      headers: {},
      bodyBuffer: Buffer.from('Request failed'),
    };
  }
}

interface RelayStatus {
  relay: string;
  isConnected: boolean;
}

async function getRelaysStatuses(pool: SimplePool, relayUrls: string[]): Promise<RelayStatus[]> {
  const allRelays = await Promise.all(relayUrls.map(relayUrl => pool.ensureRelay(relayUrl)));
  return allRelays.map(relay => ({
    relay: relay.url,
    isConnected: relay.connected,
  }));
}

export interface RunServerOptions extends ReadWriteSecretKeyOptions, ReadWriteRelaysOptions {
  verbose?: boolean;
  saveNpubFile?: string;
  allowedRoutes?: string[];
  responseManipulatorFile?: string;
  nprofileMaxRelays: string;
  timeout: string;
  saveNprofileFile?: string;
  exitOnFileChange?: boolean;
}

export async function runServer(destination: string, options: RunServerOptions): Promise<() => void> {
  const verboseLog = options.verbose ? (t: string) => console.info(t) : () => {};
  verboseLog('Installing WebSockets');
  useWebSocketImplementation(WebSocket);

  const secretKey = readWriteSecretKey(options);
  const publicKey = getPublicKey(secretKey);
  if (options.saveNpubFile) {
    console.info('Saving npub-file');
    writeFile(options.saveNpubFile, nip19.npubEncode(publicKey));
  }

  const positiveMinimatchers = options.allowedRoutes
    ? options.allowedRoutes.filter(r => r[0] !== '!').map(r => new Minimatch(r, {dot: true, platform: 'darwin'}))
    : undefined;
  const negativeMinimatchers = options.allowedRoutes
    ? options.allowedRoutes
        .filter(r => r[0] === '!')
        .map(r => new Minimatch(r.slice(1), {dot: true, platform: 'darwin'}))
    : [];

  const responseManipulatorModule: ResponseManipulatorModule | undefined =
    options.responseManipulatorFile && (await import(options.responseManipulatorFile));

  // Support both an array of relays or a single string of relays separated by spaces.
  const initialRelayUrls = readWriteRelays(options);
  let pool: SimplePool | undefined = undefined;
  const intervals: NodeJS.Timeout[] = [];
  if (initialRelayUrls.length > 0) {
    pool = new SimplePool();
    verboseLog('Connecting to relays');
    let onEvent: ((event: NostrEvent) => Promise<void>) | undefined = undefined;
    const handledEventTimes = new Map<string, number>();
    const subscribe = (since: number) =>
      pool!.subscribeMany(
        initialRelayUrls,
        [
          {
            since,
            kinds: [EphemeralGiftWrapKind],
            '#p': [publicKey],
          },
        ],
        {
          alreadyHaveEvent: eventId => handledEventTimes.has(eventId),
          onevent: event => {
            handledEventTimes.set(event.id, event.created_at);
            if (!onEvent) {
              return;
            }
            onEvent(event).catch(error => {
              console.error(`Failed to handle event ${event.id}`, error);
            });
          },
        }
      );
    let subscription = subscribe(Math.ceil(Date.now() / 1000) - 48 * 3600);
    intervals.push(
      setInterval(() => {
        const since = Math.ceil(Date.now() / 1000) - 48 * 3600;
        const newSubsription = subscribe(since);
        subscription.close();
        subscription = newSubsription;
        for (const [eventId, eventTime] of [...handledEventTimes.entries()]) {
          if (eventTime < since) {
            handledEventTimes.delete(eventId);
          }
        }
      }, 3_600_000)
    );
    await sleep(1000);
    let relaysStatuses = await getRelaysStatuses(pool, initialRelayUrls);
    if (relaysStatuses.every(status => !status.isConnected)) {
      // wait some more
      await sleep(5000);
      relaysStatuses = await getRelaysStatuses(pool, initialRelayUrls);
      if (relaysStatuses.every(status => !status.isConnected)) {
        console.error('Failed to connect to any of the relays.');
        throw new Error('Failed to connect to any of the relays.');
      }
    }
    if (options.verbose) {
      console.table(relaysStatuses);
    } else {
      console.info(`Connected to ${relaysStatuses.filter(w => w.isConnected).length}/${relaysStatuses.length} relays.`);
    }

    const requestModule = getRequestModule(destination);
    const goodRelays = relaysStatuses
      .filter(w => w.isConnected)
      .map(w => w.relay)
      .slice(0, Number(options.nprofileMaxRelays));
    const nprofile = nip19.nprofileEncode({
      pubkey: publicKey,
      relays: goodRelays,
    });

    let sinceTime = Date.now() / 1000;
    const handledRequestIds = new Map<string, number>();
    intervals.push(
      setInterval(() => {
        sinceTime = Date.now() / 1000 - 60; // up to 1 minute delay
        for (const [requestId, requestTime] of [...handledRequestIds.entries()]) {
          if (requestTime < sinceTime) {
            handledRequestIds.delete(requestId);
          }
        }
      }, 600_000)
    );

    onEvent = async (requestEvent: NostrEvent): Promise<void> => {
      verboseLog(`Event: ${JSON.stringify(requestEvent)}`);
      if (requestEvent.kind !== EphemeralGiftWrapKind) {
        return;
      }
      let requestMessage: RequestMessage;
      let requestSeal: NostrEvent;
      try {
        const decryptedSeal = nip44.v2.decrypt(
          requestEvent.content,
          nip44.getConversationKey(secretKey, requestEvent.pubkey)
        );
        verboseLog(`Decrypted seal: ${JSON.stringify(decryptedSeal)}`);
        requestSeal = JSON.parse(decryptedSeal);
        if (requestSeal.kind !== SealKind) {
          return;
        }
        if (!verifyEvent(requestSeal)) {
          verboseLog('Unverified event');
          return;
        }
        const decryptedContent = nip44.v2.decrypt(
          requestSeal.content,
          nip44.getConversationKey(secretKey, requestSeal.pubkey)
        );
        verboseLog(`Decrypted content: ${JSON.stringify(decryptedContent)}`);
        const unsignedRequest: Omit<NostrEvent, 'sig'> = JSON.parse(decryptedContent);
        if (unsignedRequest.kind !== HttpRequestKind) {
          return;
        }
        if (unsignedRequest.pubkey !== requestSeal.pubkey) {
          verboseLog('Invalid pubkey');
          return;
        }
        if (
          typeof unsignedRequest.created_at !== 'number' ||
          typeof unsignedRequest.id !== 'string' ||
          typeof unsignedRequest.content !== 'string'
        ) {
          verboseLog('Bad format');
        }
        if (unsignedRequest.created_at < sinceTime) {
          verboseLog('Old event');
          return;
        }
        if (Date.now() / 1000 + 600 < unsignedRequest.created_at) {
          verboseLog('Future event');
          return;
        }
        if (handledRequestIds.has(unsignedRequest.id)) {
          verboseLog('Handled event');
          return;
        }
        handledRequestIds.set(requestEvent.id, requestEvent.created_at);
        requestMessage = JSON.parse(unsignedRequest.content);
        if (!requestMessage || typeof requestMessage !== 'object') {
          throw new Error('Unexpected content type');
        }
        const {id, headers, method, url, bodyBase64} = requestMessage;
        if (!id || typeof id !== 'string' || id.length > 100) {
          throw new Error('Unexpected type for field: id');
        }
        if (!url || typeof url !== 'string') {
          throw new Error('Unexpected type for field: url');
        }
        if (!method || typeof method !== 'string') {
          throw new Error('Unexpected type for field: method');
        }
        if (!headers || typeof headers !== 'object' || Object.values(headers).some(v => typeof v !== 'string')) {
          throw new Error('Unexpected type for field: headers');
        }
        if (typeof bodyBase64 !== 'string') {
          throw new Error('Unexpected type for field: bodyBase64');
        }
      } catch (err) {
        console.error('Failed to handle event', err);
        return;
      }
      const logPrefix = JSON.stringify(requestMessage.id);
      console.info(
        `${logPrefix}: ${nip19.npubEncode(
          requestSeal.pubkey
        )} ${JSON.stringify(requestMessage.method)} ${JSON.stringify(requestMessage.url)}`
      );
      const responseMessage = await getResponse(requestMessage, {
        logPrefix,
        requestModule,
        destination,
        positiveMinimatchers,
        negativeMinimatchers,
        timeout: Number(options.timeout),
        responseManipulatorModule,
        secretKey,
        nprofile,
      });
      try {
        const {bodyBuffer, ...other} = responseMessage;
        const stringifiedResponseMessage = JSON.stringify({
          bodyBase64: bodyBuffer.toString('base64'),
          ...other,
          id: requestMessage.id,
        });
        verboseLog(`${logPrefix}: Sending response: ${stringifiedResponseMessage}`);
        const unsignedResponse: UnsignedEvent = {
          kind: HttpResponseKind,
          tags: [],
          content: stringifiedResponseMessage,
          created_at: Math.floor(Date.now() / 1000),
          pubkey: publicKey,
        };
        const finalUnsignedResponse: Omit<NostrEvent, 'sig'> = {
          ...unsignedResponse,
          id: getEventHash(unsignedResponse),
        };
        verboseLog(`${logPrefix}: final unsigned response: ${JSON.stringify(finalUnsignedResponse)}`);
        const now = Math.floor(Date.now() / 1000);
        const responseSeal = finalizeEvent(
          {
            created_at: now - randomInt(0, 48 * 3600),
            kind: SealKind,
            tags: [],
            content: nip44.encrypt(
              JSON.stringify(finalUnsignedResponse),
              nip44.getConversationKey(secretKey, requestSeal.pubkey)
            ),
          },
          secretKey
        );
        verboseLog(`${logPrefix}: response seal: ${JSON.stringify(responseSeal)}`);
        const randomPrivateKey = generateSecretKey();
        const normalizedRelays = initialRelayUrls.map(normalizeURL).filter((relay) => {
          const parsedRelay = new URL(relay);
          // Don't publish relay addresses that might contain sensitive information
          return !parsedRelay.username && !parsedRelay.password && !parsedRelay.search
        });
        const responseEvent = finalizeEvent(
          {
            created_at: now,
            kind: EphemeralGiftWrapKind,
            tags: [
              ['p', requestSeal.pubkey, normalizedRelays[0]],
              ...(normalizedRelays.length > 1 ? [['relays', ...normalizedRelays.slice(1)]] : []),
            ],
            content: nip44.encrypt(
              JSON.stringify(responseSeal),
              nip44.getConversationKey(randomPrivateKey, requestSeal.pubkey)
            ),
          },
          randomPrivateKey
        );
        verboseLog(`${logPrefix}: publishing response event: ${JSON.stringify(responseEvent)}`);
        await pool?.publish(initialRelayUrls, responseEvent);
        console.info(`${logPrefix}: done`);
      } catch (err) {
        console.error(`${logPrefix}: Failed to send DM reply:`, err);
      }
    };

    console.info(
      `This entity includes both your public-key and hints for ${goodRelays.length} of the relays that your are connected to: ${nprofile}`
    );
    if (options.saveNprofileFile) {
      console.info('Saving nprofile-file');
      writeFile(options.saveNprofileFile, nprofile);
    }
  } else {
    console.info('No relays to connect.');
  }
  const watchers: StatWatcher[] = [];
  const exit = () => {
    if (pool) {
      pool.close(initialRelayUrls);
      pool = undefined;
    }
    for (const filename of [options.nsecFile, options.relaysFile, options.responseManipulatorFile]) {
      if (filename) {
        unwatchFile(filename);
      }
    }
    for (const interval of intervals) {
      clearInterval(interval);
    }
  };
  if (options.exitOnFileChange) {
    if (options.nsecFile) {
      watchers.push(
        watchFile(options.nsecFile, () => {
          console.info('Exiting due to nsec-file change:', options.nsecFile);
          exit();
        })
      );
    }
    if (options.relaysFile) {
      watchers.push(
        watchFile(options.relaysFile, () => {
          console.info('Exiting due to relays-file change:', options.relaysFile);
          exit();
        })
      );
    }
    if (options.responseManipulatorFile) {
      watchers.push(
        watchFile(options.responseManipulatorFile, () => {
          console.info('Exiting due to response-manipulator-file change:', options.responseManipulatorFile);
          exit();
        })
      );
    }
  }
  return exit;
}
