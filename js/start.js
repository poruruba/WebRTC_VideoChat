'use strict';

//const vConsole = new VConsole();
//const remoteConsole = new RemoteConsole("http://[remote server]/logio-post");
//window.datgui = new dat.GUI();

const AWS_ACCESSKEY_ID = '';
const AWS_SECRET_ACCESSKEY = '';
const CHANNEL_NAME_LIST = ["Client1", "Client2", "Client3", "Client4"];

const CAMERA_WIDHT = 320;
const CAMERA_HEIGHT = 240;
const CHANNEL_PREFIX = "VC-";

var vue_options = {
    el: "#top",
    mixins: [mixins_bootstrap],
    store: vue_store,
    data: {
        master: { name: "", grid: "col-xs-6" },
        viewer_name_list: CHANNEL_NAME_LIST,
        viewer_info_list: [],
        viewer_select: "",
        input_name: "",
        signalingClient_master: null,
        AWS_ACCESSKEY_ID: AWS_ACCESSKEY_ID,
        AWS_SECRET_ACCESSKEY: AWS_SECRET_ACCESSKEY,
        volume_mute: true,
    },
    computed: {
    },
    methods: {
        master_chat: function(){
            var message = prompt("メッセージを入力してください");
            if( message ){
                var params = {
                    message: message,
                    from: this.master.name
                };
                sendMasterMessage(JSON.stringify(params));
            }
        },
        viewer_chat: function(channel){
            var message = prompt("メッセージを入力してください");
            if( message ){
                var params = {
                    message: message,
                    from: this.master.name
                };
                var viewer = this.viewer_info_list.find(item => item.name == channel);
                viewer.client.sendViewerMessage(JSON.stringify(params));
            }
        },
        viewer_add: function(){
            if( !this.viewer_select )
                return;
            var viewer = this.viewer_info_list.find(item => item.name == this.viewer_select);
            this.$set(viewer, "selected", true);
            this.$nextTick(() =>{
                this.start_viewer(this.viewer_select);
                this.onResize();
            });
        },
        stop_viewer: function(channel){
            var viewer = this.viewer_info_list.find(item => item.name == channel);
            viewer.client.stopViewer();
            viewer.selected = false;
        },
        start_viewer: async function(channel){
            try {
                var viewer = this.viewer_info_list.find(item => item.name == channel);
                viewer.client = new WebrtcClient(this.AWS_ACCESSKEY_ID, this.AWS_SECRET_ACCESSKEY);
                var params = {
                    channelName: CHANNEL_PREFIX + channel,
                    clientId: channel,
                    openDataChannel: true,
                    useTrickleICE: true,
                };
                await viewer.client.startViewer(document.querySelector('#remote-view-' + channel), params, (type, event) => {
                    console.log(type, event);
                    if (type == 'sdpAnswer' ){
                        console.log("webrtc viewer opened");
                    }else if( type == 'close'){
                        console.log("webrtc viewer closed");
                    }else if( type == 'message'){
                        var json = JSON.parse(event.event.data);
                        this.toast_show('[' + json.from + '] ' + json.message);
                    }
                });
            } catch (error) {
                console.error(error);
                alert(error);
                this.stop_viewer(channel);
            }
        },
        stop_master: function(){
            stopMaster(this.signalingClient_master);
            this.signalingClient_master = null;
            if (this.stream_master) {
                this.stream_master.getTracks().forEach(track => track.stop());
                var video = document.querySelector('#camera-view');
                video.srcObject = null;
                this.stream_master = null;
            }
        },
        start_master: async function(){
            navigator.mediaDevices.enumerateDevices()
                .then(devices => {
                    console.log(devices);
                });

            const constraints = {
                video: { facingMode: 'user', width: { ideal: CAMERA_WIDHT }, height: { ideal: CAMERA_HEIGHT } },
//                audio: { echoCancellation: true, noiseSuppression: true },
                audio: true
            };
            var video = document.querySelector('#camera-view');
            this.stream_master = await navigator.mediaDevices.getUserMedia(constraints);
            video.srcObject = this.stream_master;

            try{
                var params = {
                    accessKeyId: this.AWS_ACCESSKEY_ID,
                    secretAccessKey: this.AWS_SECRET_ACCESSKEY,
                    channelName: CHANNEL_PREFIX + this.master.name,
                    openDataChannel: true,
                    useTrickleICE: true,
                };
                this.signalingClient_master = await startMaster(this.stream_master, params, (type, event) => {
                    console.log(type, event);
                    if( type == 'open' ){
                      console.log("webrtc master opened");
                    }else if( type == 'close'){
                      console.log("webrtc master closed");
                    }else if( type == 'message'){
                        var json = JSON.parse(event.event.data);
                        this.toast_show('[' + json.from + '] ' + json.message);
                    }
                });
            } catch (error) {
                console.error(error);
                alert(error);
                this.stop_master();
            }
        },
        onResize: function(){
            this.$nextTick(() =>{
                var video = document.querySelector('#camera-view');
                var width = document.querySelector('#div_camera_view').clientWidth;
                video.width = width;
                for( var index = 0 ; index < this.viewer_info_list.length ; index++ ){
                    if( this.viewer_info_list[index].name == this.master.name )
                        continue;
                    var video = document.querySelector('#remote-view-' + this.viewer_info_list[index].name);
                    var width = document.querySelector('#div_remote_view_' + this.viewer_info_list[index].name).clientWidth;
                    video.width = width;
                }
            });
        },
        change_input_name: function(){
            if( !this.input_name )
                return;
            localStorage.setItem('videochat_master_name', this.input_name);
            localStorage.setItem('videochat_AWS_ACCESSKEY_ID', this.AWS_ACCESSKEY_ID);
            localStorage.setItem('videochat_AWS_SECRET_ACCESSKEY', this.AWS_SECRET_ACCESSKEY);
            this.master.name = this.input_name;
            this.dialog_close('#config_dialog');
        }
    },
    created: function(){
    },
    mounted: async function(){
        proc_load();

        for( let item of this.viewer_name_list)
            this.viewer_info_list.push({ name: item, grid: "col-xs-6" });

        window.addEventListener('resize', this.onResize, false);
        this.onResize();

        this.AWS_ACCESSKEY_ID = localStorage.getItem('videochat_AWS_ACCESSKEY_ID');
        this.AWS_SECRET_ACCESSKEY = localStorage.getItem('videochat_AWS_SECRET_ACCESSKEY');
        var master_name = localStorage.getItem('videochat_master_name');
        if( !master_name ){
            this.dialog_open('#config_dialog');
        }else{
            this.input_name = master_name;
            this.master.name = master_name;
        }
    }
};
vue_add_data(vue_options, { progress_title: '' }); // for progress-dialog
vue_add_global_components(components_bootstrap);
vue_add_global_components(components_utils);

/* add additional components */
  
window.vue = new Vue( vue_options );
