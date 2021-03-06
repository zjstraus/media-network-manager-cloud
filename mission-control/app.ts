import {MnMs_node, node_timers, MnMs_node_port} from "../types/types"
import {readFileSync} from "fs";

const os = require('os');
const sock = require('ws');
const http = require('http')
const https = require('https');
const exp = require('express')
const fs = require('fs');
const path = require('path')
const Datastore = require('nedb')
const _ = require('lodash');


let mdns_ = require('../multicast-dns')
let mdnss = []

const dante = require('../dante/index.js')
const sdpgetter = require("../rtsp-sdp-query")
const {spawn} = require('child_process');

// Utils
//-------------

function makeid(length) {
    let result = '';
    let characters = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    let charactersLength = characters.length;
    for (let i = 0; i < length; i++) {
        result += characters.charAt(Math.floor(Math.random() * charactersLength));
    }
    return result;
}

function blankMnmsData(d) {
    let out = JSON.parse(JSON.stringify(d))
    out.External = []
    out.Switches.forEach((s) => {
        s.Child = null
        s.Timer = null
        s.StartTime = null
    })
    return out
}

// Options and exports
//--------------------------------

let Options = {
    database: path.join(__dirname, "data.db"),
    services_port: 16060,
    clients_port: 8888,
    launch_services: null,
    launch_options: {},
    client_cb: null,
    interfaces: null
}

export = function (LocalOptions) {
    if (!LocalOptions) LocalOptions = {}
    if (LocalOptions.database) Options.database = LocalOptions.database
    if (LocalOptions.services_port) Options.services_port = LocalOptions.services_port
    if (LocalOptions.clients_port) Options.clients_port = LocalOptions.clients_port
    if (LocalOptions.launch_services) Options.launch_services = LocalOptions.launch_services
    if (LocalOptions.launch_options) Options.launch_options = LocalOptions.launch_options
    if (LocalOptions.client_cb) Options.client_cb = LocalOptions.client_cb
    if (LocalOptions.interfaces) Options.interfaces = LocalOptions.interfaces

    let MnmsData = {
        Type: "MnmsData",
        Schema: 3,
        Workspace: "Mnms - Network Name",
        CurrentTime: 0,
        Challenge: makeid(20),
        OkSwitches: 0,
        Switches: [],
        External: [],
        Mdns: {},
        Services: {
            Type: "ServiceLaunch",
            cisco_switch: {
                Type: "ciscoSG",
                User: "",
                Password: "",
                IP: ""
            },
            swos_switch: {
                Type: "SwOS",
                User: "",
                Password: "",
                IP: ""
            },
            artel_switch: {
                Type: "artelQ",
                User: "",
                Password: "",
                IP: ""
            },
            snmp_switch: {
                Type: "snmpB",
                Community: "",
                IP: ""
            }
        }
    }


        , db = new Datastore({filename: Options.database, autoload: true});
    db.find({Type: "MnmsData", Schema: MnmsData.Schema}, (err, docs) => {
        if (docs.length == 1) {
            console.log('Loading saved data')
            MnmsData = docs[0]
            MnmsData.Mdns = mdns_data
            if (!MnmsData.External) MnmsData.External = []
        }
    })


    // Side connected to other services
    //---------------------------------
    let pc_name = os.hostname()
    let prename = pc_name.split('.')[0];
    let Nodes: MnMs_node[] =
        [{
            Type: "null",
            IP: "",
            id: "0",
            Schema: 1,
            Ports: [],
            Services: {},
            Multicast: null,
            Neighbour: "",
            Mac: ""
        }]
    let Snapshot: MnMs_node[] = null
    let SelectedSnapId = 0
    let ArpCache = {};

    const privateKey = fs.readFileSync(path.join(__dirname, 'server.key'), 'utf8');
    const certificate = fs.readFileSync(path.join(__dirname, 'server.cert'), 'utf8');

    const credentials = {key: privateKey, cert: certificate};

    let httpsServer = https.createServer(credentials);
    httpsServer.listen(Options.services_port);

    const wss = new sock.Server({server: httpsServer})
    wss.on('connection', function connection(ws) {
        console.log('Service WebSocket connected')
        ws._data = {
            auth: false
        }

        ws.on("close", () => {
            console.log('Service WebSocket closed: ', ws._data)
            if (!ws._data.Info) {
                ws._data = {
                    auth: false
                }
                return
            }
            let sw = MnmsData[ws._data.Info.ServiceClass].findIndex(k => k.UID == ws._data.UID)
            if (sw != -1 && MnmsData[ws._data.Info.ServiceClass][sw].delete) {
                console.log(`Service found at ${sw}, deleting`)
                MnmsData[ws._data.Info.ServiceClass].splice(sw, 1)

                db.update({Type: 'MnmsData'}, blankMnmsData(MnmsData), {upsert: true})
            } else {
                console.log('Could not find service to remove')
            }
            ws._data = {
                auth: false
            }
        })

        ws.on('message', function incoming(message) {
            let node = JSON.parse(message)
            if (node.Type == "auth") {
                if (node.Challenge == MnmsData.Challenge) {
                    ws._data.auth = true
                    console.log('Service WebSocket authing')
                    if (!MnmsData[node.Info.ServiceClass]) MnmsData[node.Info.ServiceClass] = []
                    let sw = MnmsData[node.Info.ServiceClass].filter(k => k.UID == node.Info.id)
                    if (sw.length == 1) {
                        sw[0].Ws = ws
                    } else {
                        console.log(`Could not find id ${node.Info.id}`)
                        MnmsData[node.Info.ServiceClass].push({
                            IP: node.IP,
                            Type: node.Info.Type,
                            Ws: ws,
                            UID: node.Info.id,
                            Info: node.Info.Info
                        })
                    }


                    ws._data.UID = node.Info.id
                    ws._data.Info = node.Info
                    ws._data.ServiceClass = node.Info.ServiceClass
                } else {
                    console.log(node.Challenge, MnmsData.Challenge)
                }
            } else if (ws._data.auth) {
                if (ws._data.ServiceClass == "Switches") {
                    if (node.Type == "switch") {
                        let sw = MnmsData[ws._data.Info.ServiceClass].filter(k => k.UID == ws._data.Info.id)
                        if (sw.length == 1) {
                            let t = new Date
                            sw[0].Timer = t.getTime()
                        }
                        mergeNodes(null, node, null)
                        calculateInterConnect()
                    } else if (node.Type == "ARP") {
                        node.Data.forEach(d => {
                            let Ip = d.Ip
                            let Mac = d.Mac
                            ArpCache[Mac] = Ip
                            let D = Nodes.filter(n => n.OtherIPs && n.Macs && n.Macs.includes(d.Mac) && !n.OtherIPs.includes(d.Ip))
                            D.forEach(d => d.OtherIPs.push(Ip))
                            D = Nodes.filter(n => n.OtherIPs && n.Macs && !n.Macs.includes(d.Mac) && n.OtherIPs.includes(d.Ip))
                            D.forEach(d => d.Macs.push(Mac))
                        })
                        console.log(ArpCache)
                    } else {
                        console.error(`Unknown node type ${node.Type}`)
                    }
                } else if (ws._data.ServiceClass == "Analysers") {
                    let sw = MnmsData[ws._data.Info.ServiceClass].filter(k => k.UID == ws._data.Info.id)
                    if (sw.length == 1) {
                        sw[0].UID = ws._data.UID
                        sw[0].Ws = ws
                        sw[0].node = node
                        sw[0].delete = true
                    }
                } else {
                    console.error(`Unknown class ${ws._data.ServiceClass}`)
                }
            } else {
                console.log('Service WebSocket forbidden', ws._data, node)
            }
        });
    });


    // Handling MDNS query for mission control
    //------------------
    let mdB = []

    let mdns_data = []

    if (Options.interfaces == null) {
        mdnss.push(mdns_())
        mdns_data.push({
            Name: "all",
            Address: "224.0.0.251"
        })
    } else {
        Options.interfaces.forEach(i => {
            console.log(`Attaching MDNS to ${i}`);
            mdnss.push(mdns_({
                multicast: true, // use udp multicasting
                interface: i, // explicitly specify a network interface. defaults to all
                port: 5353, // set the udp port
                ip: '224.0.0.251', // set the udp ip
                ttl: 255, // set the multicast ttl
                loopback: true, // receive your own packets
                reuseAddr: true // set the reuseAddr option when creating the socket (requires node >=0.11.13)
            }))

            mdns_data.push({
                Name: i,
                Address: "224.0.0.251"
            })
        })
    }

    let mdnsBrowser_cb = (node) => {
        node.Name = node.Name.split(".")[0]
        if (node.Name != null) {
            mergeNodes(null, node, null)
        }
    }

    for (let i in mdnss) {
        let mdns = mdnss[i]
        mdns.on('query', (query) => {
            if (query.questions.some(k => k.name == "_missioncontrol._socketio.local")) {
                mdns.respond({
                    answers: [{
                        name: 'missioncontrol_' + prename + '._missioncontrol._socketio.local',
                        type: 'SRV',
                        data: {
                            port: 16060,
                            weigth: 0,
                            priority: 10,
                            target: prename + '.local'
                        }
                    }]
                })
            }
        })

        mdns.respond({
            answers: [{
                name: 'missioncontrol_' + prename + '._missioncontrol._socketio.local',
                type: 'SRV',
                data: {
                    port: 16060,
                    weight: 0,
                    priority: 10,
                    target: prename + '.local'
                }
            }]
        })

        // Browsing services
        //------------------
        mdB.push(require('../mdns-browser')(mdnsBrowser_cb, mdnss[i]))

    }
    // Shaping and linking data
    //-----------

    let node_timers = []
    let mergeNodesTimer = (index: number, newValue: MnMs_node) => {
        if (newValue._Timers) {
            if (!Nodes[index]._Timers) Nodes[index]._Timers = []
            for (let t of newValue._Timers) {
                let t_index = Nodes[index]._Timers.findIndex(k => k.path == t.path)
                if (t_index < 0) {
                    Nodes[index]._Timers.push(t)
                    t_index = Nodes[index]._Timers.findIndex(k => k.path == t.path)
                }
                Nodes[index]._Timers[t_index].time = t.time
                let xt: node_timers = Nodes[index]._Timers[t_index]
                if (xt.path.startsWith("$.")) newValue[xt.path.substr(2)].offline = false
                if (!node_timers[index]) node_timers[index] = {}
                if (node_timers[index][t.path]) clearTimeout(node_timers[index][t.path])
                if (xt.path.startsWith("$.")) node_timers[index][t.path] = setTimeout(function () {
                    newValue[xt.path.substr(2)].offline = true;
                }, 1000 * xt.time);
            }
        }
    }

    let mergeNodesUIParams = (index: number) => {
        if (!Nodes[index].UIParams) {
            console.log(`Building new UIParams for index ${index}`)
            Nodes[index].UIParams = {
                Ports: {
                    showUnplugged: true,
                    showPlugged: true,
                    showOff: true
                }
            }
        }
    }
    let mergePorts = (oldPs: MnMs_node_port[], newPs: MnMs_node_port[]) => {
        newPs.forEach(newP => {
            if (newP.ConnectedMacs.length == 1) {
                if (ArpCache[newP.ConnectedMacs[0]]) {
                    newP.Neighbour = ArpCache[newP.ConnectedMacs[0]]
                    console.log("New neighbor " + newP.Neighbour + " on port " + newP.Name)
                }
            }
        })
        return newPs
    }
    let mergeNodesSwitch = (index: number, newValue: MnMs_node, Name: string) => {
        if (newValue.Schema == 1) {
            if (newValue.Name) Nodes[index].Name = newValue.Name
            Nodes[index].Mac = newValue.Mac
            Nodes[index].IP = newValue.IP
            if (newValue.Macs) Nodes[index].Macs = newValue.Macs
            if (Nodes[index].Ports && Nodes[index].Ports.length != newValue.Ports.length) Nodes[index].Ports = []
            Nodes[index].Ports = mergePorts(Nodes[index].Ports, newValue.Ports)
            Nodes[index].Multicast = newValue.Multicast
            Nodes[index].id = newValue.id
            Nodes[index].Type = newValue.Type
            Nodes[index].Capabilities = newValue.Capabilities

            // Building ghost devices
            for (let p of newValue.Ports) {
                if (p.Neighbour && !Nodes.some(k => (k.IP == p.Neighbour || (k.OtherIPs && k.OtherIPs.includes(p.Neighbour))))) {
                    let N: MnMs_node = {
                        Name: "(G) " + p.Neighbour.replace(/\./g, "-"),
                        Type: "disconnected",
                        IP: p.Neighbour,
                        Neighbour: null,
                        Schema: 1,
                        Multicast: "off",
                        Mac: (p.ConnectedMacs.length > 0) ? p.ConnectedMacs[0] : "00:00:00:00:00:00",
                        id: "(G) " + p.Neighbour
                    }
                    Nodes.push(N)
                }
            }
        }
    }

    let mergeNodesMdnsManual = (index: number, newValue: MnMs_node, Name: string) => {
        if (newValue.Schema == 1) {
            if (Nodes[index].Type && Nodes[index].Type != "switch") Nodes[index].Type = newValue.Type
            if (!Nodes[index].Services) Nodes[index].Services = {}
            if (newValue.Services) Object.keys(newValue.Services).forEach((key) => {
                if (!(Nodes[index].Services[key])
                    || !(Nodes[index].Services[key].SDP
                        || _.isEqual(Nodes[index].Services[key], newValue.Services[key]))) {
                    Nodes[index].Services[key] = newValue.Services[key]
                    if (key.includes("_rtsp._tcp")) {
                        sdpgetter("rtsp://" + newValue.IP + ":" + newValue.Services[key].port + "/by-name/" + encodeURIComponent(key.split("._")[0]), (sdp) => {
                            if (Nodes[index].Services[key]) Nodes[index].Services[key].SDP = sdp
                        })
                    }
                    if (key.includes('_netaudio-arc') && Nodes[index].Services[key] && Nodes[index].Services[key].Polling != true) {
                        if (!Nodes[index].Services[key].lastPoll) Nodes[index].Services[key].lastPoll = 0
                        if (!Nodes[index].Services[key].Polling) Nodes[index].Services[key].Polling = true
                        if (!Nodes[index].Services[key].Streams) Nodes[index].Services[key].Streams = []
                        let poll = () => {
                            console.log(`Polling for ${Nodes[index].Name}`)
                            if (Nodes[index] && Nodes[index].Services[key]
                                && Nodes[index].Services[key].Streams
                                && Date.now() - Nodes[index].Services[key].lastPoll > 10000) {
                                Nodes[index].Services[key].lastPoll = Date.now()
                                dante(newValue.IP).then(k => {
                                    Nodes[index].Services[key].Streams = k;
                                    setTimeout(() => {
                                        poll()
                                    }, 15000);
                                })
                            }
                        }
                        poll()
                    }
                }
            })
            if (newValue.Services) {
                Object.keys(Nodes[index].Services).forEach((key) => {
                    if (!(newValue.Services[key])) {
                        delete Nodes[index].Services[key]
                        if (Object.keys(Nodes[index].Services).length == 0) {
                            if (Nodes[index].Type && Nodes[index].Type != "switch") Nodes[index].Type = "disconnected"
                        }
                    }
                })
            }
            if (!Nodes[index].OtherIPs)
                Nodes[index].OtherIPs = newValue.OtherIPs
            else
                newValue.OtherIPs.forEach(element => {
                    if (!Nodes[index].OtherIPs.includes(element))
                        Nodes[index].OtherIPs.push(element)
                });
            if (!Nodes[index].Macs)
                Nodes[index].Macs = newValue.Macs
            else
                newValue.Macs.forEach(element => {
                    if (!Nodes[index].Macs.includes(element))
                        Nodes[index].Macs.push(element)
                });
            if (!Nodes[index].IP)
                Nodes[index].IP = newValue.IP
            else if (!Nodes[index].OtherIPs.includes(newValue.IP))
                Nodes[index].OtherIPs.push(newValue.IP)
            Nodes[index].Neighbour = newValue.Neighbour
            Nodes[index].Mac = newValue.Mac
            Nodes[index].id = newValue.id
            Nodes[index].Name = Name || newValue.Name
        }
    }

    let findCandidates = (val: MnMs_node) => {
        let r: number
        r = Nodes.findIndex(n => n.Name == val.Name)
        if (r == -1) r = Nodes.findIndex(n => n.Mac == val.Mac)
        if (r == -1) r = Nodes.findIndex(n => (n.Macs && n.Macs.includes(val.Mac)) || (val.Macs && val.Macs.includes(n.Mac)))
        if (r == -1) r = Nodes.findIndex(n => n.IP == val.IP)
        if (r == -1) r = Nodes.findIndex(n => (n.OtherIPs && n.OtherIPs.includes(val.IP)) || (val.OtherIPs && val.OtherIPs.includes(n.IP)))
        return r
    }

    function mergeNodes(index: number, newValue: MnMs_node, Name: string) {
        index = findCandidates(newValue) || index
        if (!index || index < 0 || index > Nodes.length) {
            console.log(`Adding node "${newValue.Name}"`)
            let holder: MnMs_node = {
                Name: newValue.Name,
                Type: "disconnected",
                IP: null,
                Mac: "",
                Schema: 1,
                Multicast: "off",
                Neighbour: "",
                id: "zzz"
            }
            index = Nodes.push(holder) - 1
        }

        mergeNodesUIParams(index)
        mergeNodesTimer(index, newValue)
        switch (newValue.Type) {
            case "switch":
                mergeNodesSwitch(index, newValue, Name)
                break
            case "MdnsNode":
            case "ManualNode":
            case "missing":
                mergeNodesMdnsManual(index, newValue, Name)
                break
            case "disconnected":
                Nodes[index].Type = "disconnected"
                break
            default:
                console.log("Node type : " + newValue.Type + " not handled")
                break
        }
        if (newValue.System) Nodes[index].System = newValue.System
        if (!Nodes[index].seqnum) Nodes[index].seqnum = 0
        if (!Nodes[index].OtherIPs) Nodes[index].OtherIPs = []
        Nodes[index].seqnum++
    }

    function calculateInterConnect() {
        let linkd = []
        let conns = [];

        // Detecting interconnect
        for (let i in Nodes) {
            if (Nodes[i].Type == "switch" && Nodes[i].Ports.length > 0) {
                if (!linkd[i]) linkd[i] = {}
                linkd[i].dataRef = i;
                linkd[i].ports = [];
                conns[i] = []
                for (let j: number = 0; j < Nodes.length; j++) {
                    if (Nodes[j].Type == "switch" && Nodes[j].Ports.length > 0) {
                        for (let l in Nodes[i].Ports) {
                            if (Nodes[j].Macs && Nodes[i].Ports[l].ConnectedMacs.some(k => Nodes[j].Macs.some(l => l === k))) {
                                if (!linkd[i].ports[l]) linkd[i].ports[l] = []
                                if (!linkd[i].ports[l].some(k => k == j)) linkd[i].ports[l].push(j);
                            }
                            if (Nodes[j].Mac && Nodes[i].Ports[l].ConnectedMacs.includes(Nodes[j].Mac)) {
                                if (!linkd[i].ports[l]) linkd[i].ports[l] = []
                                if (!linkd[i].ports[l].some(k => k == j)) linkd[i].ports[l].push(j);
                            }
                        }
                    }
                }
            }
        }

        let old_cleared = null;
        while (linkd.some(k => k.ports.some(l => l.length > 1))) {
            // Checking if stalled
            let cleared = linkd.filter(k => k.ports.some(l => l.length == 1))
            if (JSON.stringify(cleared) == JSON.stringify(old_cleared)) break;
            old_cleared = JSON.parse(JSON.stringify(cleared))

            // Continuing reduction
            for (let i in linkd) {
                if (!(cleared.some(k => k.dataRef == linkd[i].dataRef))) {
                    for (let p in linkd[i].ports) {
                        if (linkd[i].ports[p] != undefined && linkd[i].ports[p].length > 1) {
                            let keep = null;
                            let ok = true
                            for (let j of linkd[i].ports[p]) {
                                if (cleared.filter(q => q.dataRef == j).length == 1) {
                                    let test = cleared.filter(q => q.dataRef == j)[0]
                                    for (let pk of test.ports) {
                                        if (pk && pk.length == 1 && pk[0] == i) {
                                            if (keep == null) keep = j;
                                            else ok = false
                                        }
                                    }
                                }
                            }
                            if (ok && keep != null) {
                                linkd[i].ports[p] = [keep]
                            }
                        }
                    }
                }
            }
        }

        // Building connection graph
        for (let i in Nodes) {
            if (Nodes[i].Type == "switch" && Nodes[i].Ports.length > 0) {
                let connlist = linkd.filter(k => k.dataRef == i)[0];
                for (let p in Nodes[i].Ports) {
                    if (connlist.ports[p]) {
                        Nodes[i].Ports[p].Neighbour = Nodes[connlist.ports[p][0]].IP
                    } else if (Nodes[i].Ports[p].ConnectedMacs.length >= 1) {
                        let d = Nodes.filter(k => k.Macs && k.Macs.some(l => Nodes[i].Ports[p].ConnectedMacs.includes(l)))
                        if (d.length >= 1) {
                            Nodes[i].Ports[p].Neighbour = d[0].IP
                        }
                    }
                }
            }
        }
        // Check vlan symmetry
        for (let list of linkd.filter(k => k.ports.some(l => l.length == 1))) {
            if (list && list.dataRef) {
                let friend = linkd.filter(k => k.ports.some(l => l == list.dataRef))
                if (friend.length == 1 && friend[0]) {
                    let listPort = -1
                    list.ports.forEach((kval, id) => {
                        if (kval.includes(parseInt(friend[0].dataRef))) {
                            listPort = id
                            console.log(list.ports, friend[0].dataRef, listPort)
                        }
                    })
                    let friendPort = -1
                    friend[0].ports.forEach((kval, id) => {
                        if (kval.includes(parseInt(list.dataRef))) {
                            friendPort = id
                            console.log(friend[0].ports, list.dataRef, friendPort)
                        }
                    })

                    // Just to fuck with your head
                    let listNode = Nodes[friend[0].dataRef]
                    let friendNode = Nodes[list.dataRef]

                    console.log("VLAN  testing " + friendNode.Name + " - " + listPort + "<->" + listNode.Name + " - " + friendPort)
                    if (listPort >= 0
                        && friendPort >= 0
                        && friendNode.Ports[listPort]
                        && listNode.Ports[friendPort]
                        && friendNode.Ports[listPort].Vlan
                        && listNode.Ports[friendPort].Vlan
                        && listNode.Ports[friendPort].Vlan.Tagged
                        && listNode.Ports[friendPort].Vlan.Tagged.sort
                        && listNode.Ports[friendPort].Vlan.Untagged
                        && listNode.Ports[friendPort].Vlan.Untagged.sort
                        && (
                            !_.isEqual(listNode.Ports[friendPort].Vlan.Tagged.sort(), friendNode.Ports[listPort].Vlan.Tagged.sort())
                            || !_.isEqual(listNode.Ports[friendPort].Vlan.Untagged.sort(), friendNode.Ports[listPort].Vlan.Untagged.sort())
                        )) {
                        if (!listNode.Errors) listNode.Errors = {}
                        if (!listNode.Errors.Ports) listNode.Errors.Ports = []
                        if (!listNode.Errors.Ports[friendPort]) listNode.Errors.Ports[friendPort] = {}
                        listNode.Errors.Ports[friendPort].vlanMissmatch = "VLAN mismatch with connection to switch " + friendNode.Name
                        if (!friendNode.Errors) friendNode.Errors = {}
                        if (!friendNode.Errors.Ports) friendNode.Errors.Ports = []
                        if (!friendNode.Errors.Ports[listPort]) friendNode.Errors.Ports[listPort] = {}
                        friendNode.Errors.Ports[listPort].vlanMissmatch = "VLAN mismatch with connection to switch " + listNode.Name


                        console.log("VLAN  mismatch for switch to switch link on " + friendNode.Name + "-" + listPort + "<->" + listNode.Name + " - " + friendPort)
                        //listNode.Errors.Ports[listPort]
                    }


                    if (listPort >= 0
                        && friendPort >= 0
                        && friendNode.Ports[listPort]
                        && listNode.Ports[friendPort]
                        && friendNode.Ports[listPort].Vlan
                        && listNode.Ports[friendPort].Vlan)
                        console.log("--------------", friendNode.Ports[listPort].Vlan, listNode.Ports[friendPort].Vlan)


                }
            }
        }
        if (SelectedSnapId != 0) compareToSnapshot()
        console.log(JSON.stringify(linkd.filter(k => k.ports.some(l => l.length == 1))))
    }


    // User and GUI side
    //------------------

    const user_app = exp();

    const server = http.createServer(user_app);

    user_app.use('/', exp.static(__dirname + '/html'));

    user_app.get('/nodes', (req, res) => {
        if (Object.keys(req.query).length == 0)
            res.send(Nodes)
        else
            res.send(Nodes.filter((N) => {
                let found = false
                Object.keys(req.query).forEach(k => {
                    found = !!(N[k]
                        && ((typeof N[k] == "number" && N[k] == req.query[k])
                            || (typeof N[k] == "string" && N[k].includes(req.query[k]))
                            || (Array.isArray(N[k]) && N[k].includes(req.query[k]))
                        ));
                })
                return found
            }))
    })

    server.listen(Options.clients_port, () => {
        console.log(`Server started on port ${Options.clients_port}`);
    });

    const user_wss = new sock.Server({server: server});
    user_wss.broadcast = function broadcast(msg) {
        user_wss.clients.forEach(function each(client) {
            client.send(msg);
        });
    };

    user_wss.on('connection', (ws) => {

        ws.on('message', (message: string) => {
            if (message == "nodes") {
                ws.send(JSON.stringify(Nodes));
            } else if (message == "data") {
                let t = new Date;
                MnmsData.CurrentTime = t.getTime()
                ws.send(JSON.stringify(MnmsData))
            } else {
                try {
                    let D = JSON.parse(message)
                    console.log(D)
                    if (D.Type && (D.Type == "ciscoSG" || D.Type == "artelQ")) {
                        if (!MnmsData.Switches.some(k => k.IP == D.IP)) {
                            MnmsData.Switches.push({
                                Type: D.Type,
                                IP: D.IP,
                                User: D.User,
                                Password: D.Password,
                                Child: null,
                                Timer: null,
                                StartTime: null,
                                UID: "manual:switch" + Date.now() + ((encodeURIComponent(D.IP)))
                            })
                            db.update({Type: "MnmsData"}, blankMnmsData(MnmsData), {upsert: true})
                            console.log(MnmsData)
                        }
                    } else if (D.Type && (D.Type == "snmpB")) {
                        if (!MnmsData.Switches.some(k => k.IP == D.IP)) {
                            MnmsData.Switches.push({
                                Type: D.Type,
                                IP: D.IP,
                                Community: D.Community,
                                Child: null,
                                Timer: null,
                                StartTime: null,
                                UID: "manual:switch" + Date.now() + ((encodeURIComponent(D.IP)))
                            })
                            db.update({Type: "MnmsData"}, blankMnmsData(MnmsData), {upsert: true})
                            console.log(MnmsData)
                        }
                    } else if (D.Type && (D.Type == "SwOS")) {
                        if (!MnmsData.Switches.some(k => k.IP == D.IP)) {
                            MnmsData.Switches.push({
                                Type: D.Type,
                                IP: D.IP,
                                User: D.User,
                                Password: D.Password,
                                Child: null,
                                Timer: null,
                                StartTime: null,
                                UID: "manual:switch" + Date.now() + ((encodeURIComponent(D.IP)))
                            })
                            db.update({Type: "MnmsData"}, blankMnmsData(MnmsData), {upsert: true})
                            console.log(MnmsData)
                        }
                    } else if (D.UserAction) {
                        if (D.UserAction == "remove_service" && D.UID) {
                            console.log("Asked to remove service of UID " + D.UID)
                            let obj = ["Switches", "External", "Analysers"]
                            let idx = 0, found = false
                            do {
                                if (MnmsData[obj[idx]]) {
                                    let l = MnmsData[obj[idx]].filter(k => k.UID == D.UID)
                                    if (l.length == 1) {
                                        console.log("Found in " + obj[idx])
                                        l[0].delete = true;
                                        let Ws = l[0].Ws
                                        Ws.close()
                                        found = true;
                                    }
                                }
                                idx++
                            }
                            while (found == false && idx < obj.length)

                            if (found) db.update({Type: "MnmsData"}, blankMnmsData(MnmsData), {upsert: true})
                        }
                    } else if (D.Type == "Snapshot::select") {
                        getSnapshot(D.id)
                            .then((v) => {
                                user_wss.broadcast(JSON.stringify(v))
                            })
                    } else if (D.Type == "Snapshot::create") {
                        createSnapshot(D.Name)
                            .then(() => {
                                listSnapshots()
                                    .then((v) => user_wss.broadcast(JSON.stringify(v)))
                            })
                    } else if (D.Type == "Workspace") {
                        MnmsData.Workspace = D.Name
                    } else {
                        console.log("No", D)
                    }
                } catch (error) {
                    console.log("Error when parsing json on message reception")
                }
            }
        });

        //send immediatly a feedback to the incoming connection    
        ws.send(JSON.stringify(MnmsData))
        ws.send(JSON.stringify(Nodes))
        listSnapshots().then(v => {
            ws.send(JSON.stringify(v))
            if (SelectedSnapId != 0) compareToSnapshot()
        })
    });


    // db and other services start
    //------------------
    const ServicesDirectory = {
        cisco_switch: "../cisco-switch/app.js",
        artel_switch: "../artel-quarra-switch/index.js",
        swos_switch: "../mikrotik-swos-switch/app.js",
        snmp_switch: "../snmp-bridge/index.js"
    }

    let serviceLauncher = (ServiceOptions) => {
        let child_info
        if (Options.launch_services) {
            child_info = Options.launch_services(ServiceOptions)
        } else {
            let type = ServiceOptions.Name.split(":")[0]
            let action = ServiceOptions.Name.split(":")[1]
            if (type == "cisco_switch") {
                if (action == "start") {
                    child_info = spawn("node", [ServicesDirectory[type], "-p", ServiceOptions.Params.Password, "-u", ServiceOptions.Params.User, "-i", ServiceOptions.Params.IP, "-k", MnmsData.Challenge, "-y", ServiceOptions.UID])
                    child_info.on("error", () => {
                        child_info.kill()
                    })
                } else if (action == "stop") {
                    if (ServiceOptions.Params.Child.kill) ServiceOptions.Params.Child.kill()
                    child_info = null;
                }
            } else if (type == "artel_switch") {
                if (action == "start") {
                    console.log([ServicesDirectory[type], "-p", ServiceOptions.Params.Password || "\"\"", "-u", ServiceOptions.Params.User, "-i", ServiceOptions.Params.IP, "-k", MnmsData.Challenge, "-y", ServiceOptions.UID])
                    if (ServiceOptions.Params.Password == "")
                        child_info = spawn("node", [ServicesDirectory[type], "-u", ServiceOptions.Params.User, "-i", ServiceOptions.Params.IP, "-k", MnmsData.Challenge, "-y", ServiceOptions.UID])
                    else
                        child_info = spawn("node", [ServicesDirectory[type], "-p", ServiceOptions.Params.Password, "-u", ServiceOptions.Params.User, "-i", ServiceOptions.Params.IP, "-k", MnmsData.Challenge, "-y", ServiceOptions.UID])

                    child_info.on("error", () => {
                        child_info.kill()
                    })
                } else if (action == "stop") {
                    if (ServiceOptions.Params.Child.kill) ServiceOptions.Params.Child.kill()
                    child_info = null;
                }
            } else if (type == "swos_switch") {
                if (action == "start") {
                    console.log([ServicesDirectory[type], "-p", ServiceOptions.Params.Password || "\"\"", "-u", ServiceOptions.Params.User, "-i", ServiceOptions.Params.IP, "-k", MnmsData.Challenge, "-y", ServiceOptions.UID])
                    if (ServiceOptions.Params.Password == "")
                        child_info = spawn("node", [ServicesDirectory[type], "-u", ServiceOptions.Params.User, "-i", ServiceOptions.Params.IP, "-k", MnmsData.Challenge, "-y", ServiceOptions.UID])
                    else
                        child_info = spawn("node", [ServicesDirectory[type], "-p", ServiceOptions.Params.Password, "-u", ServiceOptions.Params.User, "-i", ServiceOptions.Params.IP, "-k", MnmsData.Challenge, "-y", ServiceOptions.UID])

                    child_info.on("error", () => {
                        child_info.kill()
                    })
                } else if (action == "stop") {
                    if (ServiceOptions.Params.Child.kill) ServiceOptions.Params.Child.kill()
                    child_info = null;
                }
            } else if (type == "snmp_switch") {
                if (action == "start") {
                    console.log([ServicesDirectory[type], "-c", ServiceOptions.Params.Community, "-i", ServiceOptions.Params.IP, "-k", MnmsData.Challenge, "-y", ServiceOptions.UID])

                    child_info = spawn("node", [ServicesDirectory[type], "-c", ServiceOptions.Params.Community, "-i", ServiceOptions.Params.IP, "-k", MnmsData.Challenge, "-y", ServiceOptions.UID])

                    child_info.on("error", () => {
                        child_info.kill()
                    })
                } else if (action == "stop") {
                    if (ServiceOptions.Params.Child.kill) ServiceOptions.Params.Child.kill()
                    child_info = null;
                }
            }
            if (child_info) {
                child_info.stdout.on('data', (data) => {
                    console.log(`${type} ${ServiceOptions.UID}:`, data.toString())
                })
                child_info.stderr.on('data', (data) => {
                    console.error(`${type} ${ServiceOptions.UID}:`, data.toString())
                })
            }
        }
        return child_info
    }

    let switchShort = {
        "ciscoSG": "cisco_switch",
        "artelQ": "artel_switch",
        "SwOS": 'swos_switch',
        "snmpB": "snmp_switch"
    }

    let watchDog = () => {
        let now = Date.now()
        let okswitches = 0, instart = 0;
        for (let s in MnmsData.Switches) {
            if (MnmsData.Switches[s].Child) {
                if (now - MnmsData.Switches[s].Timer < 30000)
                    okswitches++
                else if (now - MnmsData.Switches[s].StartTime < 200000)
                    instart++
                else
                    MnmsData.Switches[s].Child = serviceLauncher({
                        Name: switchShort[MnmsData.Switches[s].Type] + ":stop",
                        Params: {Child: MnmsData.Switches[s].Child},
                        Challenge: MnmsData.Challenge,
                        UID: MnmsData.Switches[s].UID
                    })
            } else {
                MnmsData.Switches[s].StartTime = Date.now()
                MnmsData.Switches[s].Child = "starting"
                MnmsData.Switches[s].Child = serviceLauncher({
                    Name: switchShort[MnmsData.Switches[s].Type] + ":start",
                    Params: {
                        IP: MnmsData.Switches[s].IP,
                        User: MnmsData.Switches[s].User,
                        Password: MnmsData.Switches[s].Password,
                        Community: MnmsData.Switches[s].Community
                    },
                    Challenge: MnmsData.Challenge,
                    UID: MnmsData.Switches[s].UID
                })
            }
        }
        MnmsData.OkSwitches = okswitches
    }

    let loadStaticConfig = () => {
        try {
            let file = readFileSync("devices.json")
            let Data = JSON.parse(file.toString())
            for (let p of Data) {
                if (p.Name) {
                    if (p.Macs) for (let i = 0; i < p.Macs.length; i++)
                        p.Macs[i] = p.Macs[i].toLowerCase()
                    let N: MnMs_node = {
                        Name: "(S) " + p.Name,
                        Type: "disconnected",
                        IP: (p.IPs && p.IPs.length > 0) ? p.IPs[0] : "",
                        Neighbour: null,
                        Schema: 1,
                        Multicast: "off",
                        Mac: (p.Macs && p.Macs.length > 0) ? p.Macs[0] : "00:00:00:00:00:00",
                        id: "(S) " + p.Neighbour
                    }
                    if (p.IPs) N.OtherIPs = p.IPs
                    else N.OtherIPs = []
                    if (p.Macs) N.Macs = p.Macs;
                    Nodes.push(N)
                }
            }
        } catch (e) {
            console.error(e)
        }
    }

    loadStaticConfig()

    setInterval(watchDog, 2000)

    // Snapshot

    let getSnapshot = (id) => {
        return new Promise((resolve, error) => {

            while (Nodes.some(n => n.Type == "missing")) {
                let id = Nodes.findIndex(n => n.Type == "missing")
                Nodes.splice(id, 1)
            }
            if (id == 0) {
                Snapshot = null
                SelectedSnapId = 0
                resolve({
                    Type: "MnmsSnapshot",
                    List: null,
                    Options: null,
                    Selected: id,
                    Errors: []
                })
            }
            db.find({Type: "MnmsSnapshot", id: id}, (err, docs) => {
                console.log(docs)
                if (docs.length == 1) {
                    Snapshot = JSON.parse(docs[0].Data)
                    SelectedSnapId = id
                    resolve({
                        Type: "MnmsSnapshot",
                        List: null,
                        Options: null,
                        Selected: id,
                        Errors: null
                    })
                    compareToSnapshot()
                }
            })
        })
    }

    let listSnapshots = () => {
        return new Promise((resolve, error) => {
            db.find({Type: "MnmsSnapshot"}, (err, docs) => {
                console.log(docs)
                let L = [{Name: "no snapshot", id: 0}]
                docs.forEach(element => {
                    L.push({Name: element.Name, id: element.id})
                });
                resolve({
                    Type: "MnmsSnapshot",
                    List: L,
                    Options: null,
                    Selected: SelectedSnapId,
                    Errors: null
                })
            })
        })
    }

    let createSnapshot = (Name) => {
        console.log("Creating snapshots")
        let Snap = {
            Type: "MnmsSnapshot",
            Data: JSON.stringify(Nodes),
            Name: Name,
            id: "snap-" + Date.now()
        }
        return new Promise((resolve, error) => {
            db.update({Type: "MnmsSnapshot", id: Snap.id}, Snap, {upsert: true}, (err, newDoc) => {
                if (err)
                    console.log(err)
                resolve()
            })
        })
    }

    let removeSnapshot = (id) => {
        db.remove({Type: "MnmsSnapshot", id: id})
    }

    let compareToSnapshot = () => {
        let Errors = []
        Nodes.forEach(node => {
            let snode = Snapshot.filter(k => k.Name == node.Name)
            if (snode.length == 0) {
                // Device is new
                Errors.push({
                    Type: "new",
                    Name: node.Name
                })
            } else {
                let snap = snode[0]
                let mods = []
                let targetHasIP = (IP, target: MnMs_node) => {
                    let found = false
                    if (target.IP == IP) found = true
                    if (target.OtherIPs && target.OtherIPs.includes(IP)) found = true
                    return found
                }
                let checkAllIPs = (source: MnMs_node, target: MnMs_node) => {
                    let missingIPs = []
                    if (!targetHasIP(source.IP, target))
                        missingIPs.push(source.IP)
                    if (source.OtherIPs)
                        source.OtherIPs.forEach(i => {
                            if (!targetHasIP(i, target))
                                missingIPs.push(i)
                        })
                    return missingIPs
                }
                // Checking IPs
                let missingIPs = checkAllIPs(snap, node)
                if (missingIPs.length > 0)
                    mods.push({type: "missing IPs", data: missingIPs})
                let newIPs = checkAllIPs(node, snap)
                if (newIPs.length > 0)
                    mods.push({type: "new IPs", data: newIPs})

                // Checking Macs
                // TO DO

                // Checking services
                // TO DO

                // Checking bandwidth on ports
                Nodes.forEach(n => {
                    if (n.Type == "switch") {
                        let interfaces = n.Ports.filter(p => p.Neighbour && (node.IP == p.Neighbour || (node.OtherIPs && node.OtherIPs.includes(p.Neighbour))))
                        interfaces.forEach(int => {
                            let SnapSw = Snapshot.filter(sn => sn.Name == n.Name && sn.Type == "switch")
                            if (SnapSw.length == 0) {
                                mods.push({type: "Switch changed", data: null})
                            } else {
                                let snint = SnapSw[0].Ports.filter(pp => pp.Name == int.Name)
                                if (snint.length == 0) {
                                    mods.push({type: "Switch port changed", data: null})
                                } else {
                                    if (int.In > 1 && int.In > snint[0].In * 1.2 || int.In < snint[0].In * 0.8)
                                        mods.push({type: "Input bandwith changed", data: null})
                                    if (int.Out > 1 && int.Out > snint[0].Out * 1.2 || int.Out < snint[0].Out * 0.8)
                                        mods.push({type: "Output bandwith changed", data: null})
                                }
                            }
                        })
                    }
                })

                // Finalizing
                if (mods.length > 0)
                    Errors.push({
                        Type: "modified",
                        Name: node.Name,
                        Data: mods
                    })
            }
        })
        Snapshot.forEach(node => {
            let snode = Nodes.filter(k => k.Name == node.Name && node.Type != "missing")
            if (snode.length == 0) {
                // Device is new
                Errors.push({
                    Type: "missing",
                    Name: node.Name
                })
                node.IP = ""
                node.OtherIPs = []
                node.Macs = []
                node.Mac = ""
                node.Type = "missing"
                mergeNodes(null, node, null)
            }
        })
        if (Errors.length > 0)
            user_wss.broadcast(JSON.stringify({
                Type: "MnmsSnapshot",
                List: null,
                Options: null,
                Selected: SelectedSnapId,
                Errors: Errors
            }))
    }
}

