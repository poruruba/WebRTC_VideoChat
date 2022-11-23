const master = {
    peerConnectionByClientId: {},
    dataChannelByClientId: {},
};

let master_datachannel_counter = 0;

async function getRuntimeConfig(params)
{
    // Create KVS client
    const kinesisVideoClient = new AWS.KinesisVideo({
        region: 'ap-northeast-1',
        accessKeyId: params.accessKeyId,
        secretAccessKey: params.secretAccessKey,
        correctClockSkew: true,
    });

    // Get signaling channel ARN
    const describeSignalingChannelResponse = await kinesisVideoClient
        .describeSignalingChannel({
            ChannelName: params.channelName,
        })
        .promise();
    const channelARN = describeSignalingChannelResponse.ChannelInfo.ChannelARN;
    console.log('[MASTER] Channel ARN: ', channelARN);

    // Get signaling channel endpoints
    const getSignalingChannelEndpointResponse = await kinesisVideoClient
        .getSignalingChannelEndpoint({
            ChannelARN: channelARN,
            SingleMasterChannelEndpointConfiguration: {
                Protocols: ['WSS', 'HTTPS'],
                Role: params.role,
            },
        })
        .promise();
    const endpointsByProtocol = getSignalingChannelEndpointResponse.ResourceEndpointList.reduce((endpoints, endpoint) => {
        endpoints[endpoint.Protocol] = endpoint.ResourceEndpoint;
        return endpoints;
    }, {});
    console.log('[MASTER] Endpoints: ', endpointsByProtocol);

    return {
        channelARN: channelARN,
        endpointsByProtocol: endpointsByProtocol,
        systemClockOffset: kinesisVideoClient.config.systemClockOffset,
    };
}

async function getIceServers(params, config)
{
    // Get ICE server configuration
    const kinesisVideoSignalingChannelsClient = new AWS.KinesisVideoSignalingChannels({
        region: 'ap-northeast-1',
        accessKeyId: params.accessKeyId,
        secretAccessKey: params.secretAccessKey,
        endpoint: config.endpointsByProtocol.HTTPS,
        correctClockSkew: true,
    });
    const getIceServerConfigResponse = await kinesisVideoSignalingChannelsClient
        .getIceServerConfig({
            ChannelARN: config.channelARN,
        })
        .promise();
    const iceServers = [];
    iceServers.push({ urls: `stun:stun.kinesisvideo.ap-northeast-1.amazonaws.com:443` });
    getIceServerConfigResponse.IceServerList.forEach(iceServer =>
        iceServers.push({
            urls: iceServer.Uris,
            username: iceServer.Username,
            credential: iceServer.Password,
        }),
    );
    console.log('[MASTER] ICE servers: ', iceServers);

    return iceServers;
}

async function startMaster(localStream, formValues, callback) {
    console.log("call: startMaster");

    let params = {
        accessKeyId: formValues.accessKeyId,
        secretAccessKey: formValues.secretAccessKey,
        channelName: formValues.channelName,
        role: KVSWebRTC.Role.MASTER
    };
    let config = await getRuntimeConfig(params);
    let iceServers = await getIceServers(params, config);

    // Create Signaling Client
    let signalingClient = new KVSWebRTC.SignalingClient({
        channelARN: config.channelARN,
        channelEndpoint: config.endpointsByProtocol.WSS,
        role: params.role,
        region: 'ap-northeast-1',
        credentials: {
            accessKeyId: params.accessKeyId,
            secretAccessKey: params.secretAccessKey,
        },
        systemClockOffset: config.systemClockOffset,
    });

    signalingClient.on('open', async () => {
        console.log('[MASTER] Connected to signaling service');
        if( callback )
            callback('open');
    });

    signalingClient.on('sdpOffer', async (offer, remoteClientId) => {
        try{
            console.log('[MASTER] Received SDP offer from client: ' + remoteClientId);

            const configuration = {
                iceServers,
                iceTransportPolicy: 'all',
            };

            // Create a new peer connection using the offer from the given client
            const peerConnection = new RTCPeerConnection(configuration);
            master.peerConnectionByClientId[remoteClientId] = peerConnection;

            if (formValues.openDataChannel) {
                master.dataChannelByClientId[String(master_datachannel_counter++)] = peerConnection.createDataChannel(formValues.dataChannelName || 'kvsDataChannel');
                peerConnection.ondatachannel = event => {
                    event.channel.onmessage = (e) =>{
                        if( callback )
                            callback("message", { target: remoteClientId, event: e } );
                    };
                };
            }

            // Send any ICE candidates to the other peer
            peerConnection.addEventListener('icecandidate', ({ candidate }) => {
                if (candidate) {
                    console.log('[MASTER] Generated ICE candidate for client: ' + remoteClientId);

                    // When trickle ICE is enabled, send the ICE candidates as they are generated.
                    if (formValues.useTrickleICE) {
                        console.log('[MASTER] Sending ICE candidate to client: ' + remoteClientId);
                        signalingClient.sendIceCandidate(candidate, remoteClientId);
                    }
                } else {
                    console.log('[MASTER] All ICE candidates have been generated for client: ' + remoteClientId);

                    // When trickle ICE is disabled, send the answer now that all the ICE candidates have ben generated.
                    if (!formValues.useTrickleICE) {
                        console.log('[MASTER] Sending SDP answer to client: ' + remoteClientId);
                        signalingClient.sendSdpAnswer(peerConnection.localDescription, remoteClientId);
                    }
                }
            });

            // As remote tracks are received, add them to the remote view
            peerConnection.addEventListener('track', event => {
                console.log('[MASTER] Received remote track from client: ' + remoteClientId);
                if (callback)
                    callback("track", { target: remoteClientId, event: event });
            });
            
            // If there's no video/audio, master.localStream will be null. So, we should skip adding the tracks from it.
            localStream.getTracks().forEach(track => peerConnection.addTrack(track, localStream));

            await peerConnection.setRemoteDescription(offer);

            // Create an SDP answer to send back to the client
            console.log('[MASTER] Creating SDP answer for client: ' + remoteClientId);
            await peerConnection.setLocalDescription(
                await peerConnection.createAnswer({
                    offerToReceiveAudio: false,
                    offerToReceiveVideo: false,
                }),
            );

            // When trickle ICE is enabled, send the answer now and then send ICE candidates as they are generated. Otherwise wait on the ICE candidates.
            if (formValues.useTrickleICE) {
                console.log('[MASTER] Sending SDP answer to client: ' + remoteClientId);
                signalingClient.sendSdpAnswer(peerConnection.localDescription, remoteClientId);
            }

            if (callback)
                callback("sdpOffer", { target: remoteClientId });
            console.log('[MASTER] Generating ICE candidates for client: ' + remoteClientId);
        }catch(error){
            console.error(error);
        }
    });

    signalingClient.on('iceCandidate', async (candidate, remoteClientId) => {
        console.log('[MASTER] Received ICE candidate from client: ' + remoteClientId);

        // Add the ICE candidate received from the client to the peer connection
        const peerConnection = master.peerConnectionByClientId[remoteClientId];
        peerConnection.addIceCandidate(candidate);
    });

    signalingClient.on('close', () => {
        console.log('[MASTER] Disconnected from signaling channel');
        if (callback)
            callback('close');
    });

    signalingClient.on('error', (error) => {
        console.error('[MASTER] Signaling client error: ', error);
        if (callback)
            callback('error', error);
    });

    console.log('[MASTER] Starting master connection');
    signalingClient.open();

    return signalingClient;
}

function stopMaster(signalingClient) {
    console.log('[MASTER] Stopping master connection');
    if (signalingClient) {
        signalingClient.close();
        signalingClient = null;
    }

    Object.keys(master.peerConnectionByClientId).forEach(clientId => {
        master.peerConnectionByClientId[clientId].close();
    });
    master.peerConnectionByClientId = [];

    if (master.dataChannelByClientId) {
        master.dataChannelByClientId = {};
    }
}

function sendMasterMessage(message) {
    console.log("call: sendMasterMessage");

    Object.keys(master.dataChannelByClientId).forEach(clientId => {
        try {
            if (master.dataChannelByClientId[clientId].readyState == "open")
                master.dataChannelByClientId[clientId].send(message);
        } catch (e) {
            console.log(master.dataChannelByClientId[clientId].readyState);
            console.error('[MASTER] Send DataChannel: ', e.toString());
        }
    });
}
