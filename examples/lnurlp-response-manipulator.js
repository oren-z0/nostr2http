// Manipulates payRequest json responses. If the callback url domain is the same as the
// destination (i.e. it's an ip address in our local network and is not accessible from outside),
// then we change the callback to begin with 'nostr1+http://<server-npub>/'. This way the
// client will know that the second request should also be sent to us over nostr.
// For example, if you are running LNbits with the lnurlp extension on you home network (i.e
// behind NAT), download this file to a local folder in your Umbrel machine and run the following
// command:
// npx nostr2http --relays wss://relay.damus.io wss://nos.lol wss://relay.snort.social \
//  --nsec-file my-nsec.txt --save-nsec --allowed-routes '/lnurlp/**' --response-manipulator-file
//  lnurlp-response-manipulator.js http://127.0.0.1:3007

module.exports = ({ responseMessage, keys, destination }) => {
  if (responseMessage.headers['content-type'] !== 'application/json') {
    return;
  }
  let responseBody;
  try {
    responseBody = JSON.parse(responseMessage.bodyBuffer);
  } catch (err) {
    console.error("Failed to parse json body", err);
    return responseMessage;
  }
  if (
    !responseBody ||
    responseBody.tag !== 'payRequest' ||
    typeof responseBody.callback !== 'string' ||
    !responseBody.callback.startsWith(destination + '/')
  ) {
    return;
  }
  return {
    ...responseMessage,
    bodyBuffer: Buffer.from(JSON.stringify({
      ...responseBody,
      callback: `nostr1+http://${keys.publicKey.toBech32()}${responseBody.callback.slice(destination.length)}`
    }))
  };
};
