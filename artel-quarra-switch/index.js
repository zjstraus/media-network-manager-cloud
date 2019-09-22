"use strict";
exports.__esModule = true;
var request = require('request');
var SwitchPollTime = 5;
var commandLineArgs = require('command-line-args');
// Command line arguments
var optionDefinitions = [
    { name: 'ip', alias: 'i', type: String, defaultValue: '192.168.1.143' },
    { name: 'user', alias: 'u', type: String, defaultValue: 'admin' },
    { name: 'password', alias: 'p', type: String, defaultValue: '' },
    { name: 'key', alias: 'k', type: String, defaultValue: 'nokey' },
    { name: 'id', alias: 'y', type: String, defaultValue: 'noid' },
    { name: "missioncontrol", alias: "m", type: String }
];
var options = commandLineArgs(optionDefinitions);
console.log(options);
var client = require('../mnms-client-ws-interface');
client.challenge(options.key);
client.whoami("mnms client ws test prgm");
client.setCallback(function (data) { console.log(data); });
client.run(options.missioncontrol);
// Connecting to switch
var SwitchData = {
    oldT: 0
};
var OldValue = {};
var Switch = {
    Name: "Artel",
    Type: "switch",
    IP: options.ip,
    Schema: 1,
    Ports: [],
    Multicast: "off",
    Neighbour: "",
    Mac: "",
    id: options.id
};
var ActionCount = 0;
var ClearTime = 0;
var CountTime = 0;
var NewData;
var postReq = function (path, handle) {
    request.post("http://" + options.user + ":" + options.password + "@" + options.ip + "/json_rpc", {
        json: {
            "method": path, "params": [], "id": "0"
        }
    }, function (error, res, body) {
        if (error) {
            console.error(error);
            return;
        }
        if (res.statusCode == 200) {
            handle(body);
            nextCmd(path);
        }
        else
            console.log(path + " -> statusCode: " + res.statusCode);
        //console.log(`statusCode: ${res.statusCode}`)
        //console.log(body.result[0].val)
    });
};
var waitNext = function () {
    setTimeout(nextCmd, SwitchPollTime * 1000);
};
var getStatistics = function (body) {
    var nowT = Date.now();
    body.result.forEach(function (port) {
        if (SwitchData[port.key]) {
            SwitchData[port.key].In = (port.val.RxOctets - SwitchData[port.key].InOctets) / (nowT - SwitchData.oldT);
            SwitchData[port.key].Out = (port.val.TxOctets - SwitchData[port.key].OutOctets) / (nowT - SwitchData.oldT);
        }
        else {
            SwitchData[port.key] = {
                In: 0,
                Out: 0
            };
        }
        SwitchData[port.key] = {
            InOctets: port.val.RxOctets,
            OutOctets: port.val.TxOctets,
            In: Math.round(SwitchData[port.key].In / 1024 / 1024 * 10 * 1000) / 10,
            Out: Math.round(SwitchData[port.key].Out / 1024 / 1024 * 10 * 1000) / 10
        };
    });
    SwitchData.oldT = nowT;
};
var getPortStatus = function (body) {
    Switch.Ports = [];
    body.result.forEach(function (port) {
        var swp = {
            Name: port.key.split(" 1/").join(""),
            ConnectedMacs: [],
            IGMP: {
                ForwardAll: "on",
                Groups: {}
            },
            AdminState: "Down",
            Speed: port.val.Link == true ? (port.val.Speed == "speed1G" ? 1000 : 100) : 0,
            In: SwitchData[port.key].In,
            Out: SwitchData[port.key].Out
        };
        Switch.Ports.push(swp);
    });
};
var getPortConfig = function (body) {
    body.result.forEach(function (port) {
        //console.log(port.key,port.val)
        Switch.Ports[Switch.Ports.findIndex(function (k) { return k.Name == port.key.split(" 1/").join(""); })].AdminState = (port.val.Shutdown == "false") ? "Down" : "Up";
    });
};
var getMacs = function (body) {
    Switch.Ports.forEach(function (element) {
        element.ConnectedMacs = [];
    });
    body.result.forEach(function (mac) {
        //console.log(mac.key, mac.val)
        mac.val.PortList.forEach(function (p) {
            Switch.Ports[Switch.Ports.findIndex(function (k) { return k.Name == p.split(" 1/").join(""); })].ConnectedMacs.push(mac.key[1].toLowerCase());
        });
        if (mac.val.PortList.length == 0 && mac.val.CopyToCpu == 1) {
            Switch.Mac = mac.key[1].toLowerCase();
            Switch.Macs = [mac.key[1].toLowerCase()];
            Switch.Name = "Artel " + mac.key[1].toLowerCase().substr(-8);
        }
    });
};
var nextCmd = function (path) {
    switch (path) {
        case "port.statistics.rmon.get":
            postReq("port.status.get", getPortStatus);
            break;
        case "port.status.get":
            postReq("port.config.get", getPortConfig);
            break;
        case "port.config.get":
            postReq("ipmc-snooping.status.igmp.vlan.get", function (r) { return null; });
            break;
        case "ipmc-snooping.status.igmp.vlan.get":
            postReq("mac.status.fdb.full.get", getMacs);
            break;
        case "mac.status.fdb.full.get":
            postReq("ipmc-snooping.status.igmp.group-src-list.get", function (r) { return null; });
            break;
        case "ipmc-snooping.status.igmp.group-src-list.get":
            client.send(JSON.stringify(Switch));
            console.log(Switch);
            waitNext();
            break;
        default:
            postReq("port.statistics.rmon.get", getStatistics);
            break;
    }
};
postReq("port.statistics.rmon.get", getStatistics);
