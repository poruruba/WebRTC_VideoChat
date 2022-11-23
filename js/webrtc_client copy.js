/**
 * This file demonstrates the process of starting WebRTC streaming using a KVS Signaling Channel.
 */
 const viewer = {};

 async function getRuntimeConfig(params) {
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
 
 async function getIceServers(params, config) {
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
 
 async function startViewer(remoteView, formValues, callback) {
     console.log("call: startViewer");
 
     viewer.remoteView = remoteView;
 
     var params = {
         accessKeyId: formValues.accessKeyId,
         secretAccessKey: formValues.secretAccessKey,
         channelName: formValues.channelName,
         role: KVSWebRTC.Role.VIEWER
     };
     var config = await getRuntimeConfig(params);
     var iceServers = await getIceServers(params, config);
 
     // Create Signaling Client
     let signalingClient = new KVSWebRTC.SignalingClient({
         channelARN: config.channelARN,
         channelEndpoint: config.endpointsByProtocol.WSS,
         clientId: formValues.clientId,
         role: params.role,
         region: 'ap-northeast-1',
         credentials: {
             accessKeyId: params.accessKeyId,
             secretAccessKey: params.secretAccessKey,
         },
         systemClockOffset: config.systemClockOffset,
     });
 
     const configuration = {
         iceServers,
         iceTransportPolicy: 'all',
     };
     viewer.peerConnection = new RTCPeerConnection(configuration);
 
     if (formValues.openDataChannel) {
         viewer.dataChannel = viewer.peerConnection.createDataChannel(formValues.dataChannelName || 'kvsDataChannel');
         viewer.peerConnection.ondatachannel = (event) => {
             event.channel.onmessage = (e) => {
                 if (callback)
                     callback("message", { event: e });
             };
         };
     }
 
     signalingClient.on('open', async () => {
         // Create an SDP offer to send to the master
         console.log('[VIEWER] Creating SDP offer');
         await viewer.peerConnection.setLocalDescription(
             await viewer.peerConnection.createOffer({
                 offerToReceiveAudio: true,
                 offerToReceiveVideo: true,
             }),
         );
 
         // When trickle ICE is enabled, send the offer now and then send ICE candidates as they are generated. Otherwise wait on the ICE candidates.
         if (formValues.useTrickleICE) {
             console.log('[VIEWER] Sending SDP offer');
             signalingClient.sendSdpOffer(viewer.peerConnection.localDescription);
         }
         console.log('[VIEWER] Generating ICE candidates');
     });
 
     signalingClient.on('sdpAnswer', async answer => {
         // Add the SDP answer to the peer connection
         console.log('[VIEWER] Received SDP answer');
         await viewer.peerConnection.setRemoteDescription(answer);
         if (callback)
             callback('sdpAnswer', { answer: answer });
     });
 
     signalingClient.on('iceCandidate', candidate => {
         // Add the ICE candidate received from the MASTER to the peer connection
         console.log('[VIEWER] Received ICE candidate');
         viewer.peerConnection.addIceCandidate(candidate);
     });
 
     signalingClient.on('close', () => {
         console.log('[VIEWER] Disconnected from signaling channel');
         if (callback)
             callback('close');
     });
 
     signalingClient.on('error', error => {
         console.error('[VIEWER] Signaling client error: ', error);
         if (callback)
             callback('error', error);
     });
 
     // Send any ICE candidates to the other peer
     viewer.peerConnection.addEventListener('icecandidate', ({ candidate }) => {
         if (candidate) {
             console.log('[VIEWER] Generated ICE candidate');
 
             // When trickle ICE is enabled, send the ICE candidates as they are generated.
             if (formValues.useTrickleICE) {
                 console.log('[VIEWER] Sending ICE candidate');
                 signalingClient.sendIceCandidate(candidate);
             }
         } else {
             console.log('[VIEWER] All ICE candidates have been generated');
 
             // When trickle ICE is disabled, send the offer now that all the ICE candidates have ben generated.
             if (!formValues.useTrickleICE) {
                 console.log('[VIEWER] Sending SDP offer');
                 signalingClient.sendSdpOffer(viewer.peerConnection.localDescription);
             }
         }
     });
 
     // As remote tracks are received, add them to the remote view
     viewer.peerConnection.addEventListener('track', event => {
         console.log('[VIEWER] Received remote track');
         if (remoteView.srcObject) {
             return;
         }
         viewer.remoteStream = event.streams[0];
         remoteView.srcObject = viewer.remoteStream;
     });
 
     console.log('[VIEWER] Starting viewer connection');
     signalingClient.open();
 
     return signalingClient;
 }
 
 function stopViewer(signalingClient) {
     console.log('[VIEWER] Stopping viewer connection');
     if (signalingClient) {
         signalingClient.close();
         signalingClient = null;
     }
 
     if (viewer.peerConnection) {
         viewer.peerConnection.close();
         viewer.peerConnection = null;
     }
 
     if (viewer.remoteStream) {
         viewer.remoteStream.getTracks().forEach(track => track.stop());
         viewer.remoteStream = null;
     }
 
     if (viewer.remoteView) {
         viewer.remoteView.srcObject = null;
     }
 
     if (viewer.dataChannel) {
         viewer.dataChannel = null;
     }
 }
 
 function sendViewerMessage(message) {
     console.log("call: sendViewerMessage(viewer.js)");
 
     if (viewer.dataChannel) {
         try {
             viewer.dataChannel.send(message);
         } catch (e) {
             console.error('[VIEWER] Send DataChannel: ', e.toString());
         }
     }
 }
 