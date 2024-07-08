// Manipulates payRequest json responses. If the callback url domain is the same as the
// destination (i.e. it's an ip address in our local network and is not accessible from outside),
// then we change the callback to begin with 'http://<server-nnprofile>.nostr/'. This way the
// client will know that the second request should also be sent to us over nostr.
// For example, if you are running LNbits with the lnurlp extension on you home network (i.e
// behind NAT), download this file to a local folder in your Umbrel machine and run the following
// command:
// npx nostr2http --relays wss://relay.damus.io wss://nos.lol wss://relay.snort.social \
//  --nsec-file my-nsec.txt --save-nsec --allowed-routes '/lnurlp/**' --response-manipulator-file
//  lnurlp-response-manipulator.js http://127.0.0.1:3007

export default ({response, destination, nprofile}) => {
  if (response.headers['content-type'] !== 'application/json') {
    return;
  }
  let responseBody;
  try {
    responseBody = JSON.parse(response.bodyBuffer);
  } catch (err) {
    console.error('Failed to parse json body', err);
    return;
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
    ...response,
    bodyBuffer: Buffer.from(
      JSON.stringify({
        ...responseBody,
        callback: `http://${nprofile}.nostr${responseBody.callback.slice(destination.length)}`,
      })
    ),
  };
};
