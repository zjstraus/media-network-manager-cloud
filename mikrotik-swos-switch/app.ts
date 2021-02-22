const SwitchPollTime = 15000

const digestFetch = require('digest-fetch')
const commandLineArgs = require('command-line-args')
const client = require('../mnms-client-ws-interface')

import {MnMs_node, MnMs_node_port} from '../types/types'

// Command line arguments
const optionDefinitions = [
    {name: 'ip', alias: 'i', type: String, defaultValue: '192.168.1.201'},
    {name: 'user', alias: 'u', type: String, defaultValue: 'admin'},
    {name: 'password', alias: 'p', type: String, defaultValue: ''},
    {name: 'key', alias: 'k', type: String, defaultValue: 'nokey'},
    {name: 'id', alias: 'y', type: String, defaultValue: undefined},
    {name: 'missioncontrol', alias: 'm', type: String},
]

const options = commandLineArgs(optionDefinitions)

client.challenge(options.key)
client.setCallback((data) => {
    console.log(data)
})
client.run(options.missioncontrol, false)
client.info({
    Info: 'SwOS switch client',
    ServiceClass: 'Switches',
    id: options.id,
})

// Connecting to switch

let SwitchData: { [key: number]: MnMs_node_port } = {}
let VLANDefs = {}
let Switch: MnMs_node = {
    Type: 'switch',
    IP: options.ip,
    Schema: 1,
    Ports: [],
    Multicast: 'off',
    Neighbour: '',
    Mac: '',
    id: options.id,
    System: {
        CPU5s: 0,
        CPU1min: 0,
        CPU5min: 0,
        CPUSpeeds: [],
        CPUTemps: [],
        DiskBuzy: 0,
    },
}

let httpClient = new digestFetch(options.user, options.password)

function convertMikrotikString(input: string): string {
    return Buffer.from(input, 'hex').toString()
}

function convertNumberToIp(input) {
    let b1 = input & 255
    let b2 = (input >> 8) & 255
    let b3 = (input >> 16) & 255
    let b4 = (input >> 24) & 255
    return `${b1}.${b2}.${b3}.${b4}`
}

function formatMAC(input) {
    return input.replace(/(..)/g, '$1:').slice(0,-1)
}

async function getStats() {
    try {
        let response = await httpClient.fetch(`http://${options.ip}/!stats.b`)
        let body = await response.text()
        let parsedData = eval('(' + body + ')')

        for (let port in SwitchData) {
            SwitchData[port].In = parsedData.rb[port]
            SwitchData[port].Out = parsedData.tb[port]
        }
    } catch (error) {
        console.error('Error getting swos !stats.b', error)
    }
    setTimeout(getStats, SwitchPollTime)
}

function sendUpdate() {
    Switch.Ports = []
    for (let port in SwitchData) {
        Switch.Ports.push(SwitchData[port])
    }
    try {
        client.send(JSON.stringify(Switch))
    } catch (error) {
        console.error('Waiting to reconnect to ws...', error)
    }
    setTimeout(sendUpdate, 5000)
}

async function getPortStatus() {
    try {
        let response = await httpClient.fetch(`http://${options.ip}/link.b`)
        let body = await response.text()
        let parsedData = eval('(' + body + ')')

        for (let i = 0; i < parsedData.prt; i++) {
            let name = convertMikrotikString(parsedData.nm[i])
            let enabled = (parsedData.en & (1 << i)) > 0 ? 'Up' : 'n.c.'
            let speed = parsedData.spd[i]
            if (speed < 7) {
                speed = 10 * Math.pow(10, speed)
            } else {
                speed = 'n.c.'
            }

            if (SwitchData[i]) {
                SwitchData[i].Name = name
                SwitchData[i].AdminState = enabled
                SwitchData[i].Speed = speed
            } else {
                SwitchData[i] = {
                    Name: name,
                    ConnectedMacs: [],
                    IGMP: {
                        ForwardAll: 'off',
                        Groups: {},
                    },
                    Vlan: {
                        Untagged: [],
                        Tagged: [],
                    },
                    AdminState: enabled,
                    Speed: speed,
                    In: 0,
                    Out: 0,
                }
            }
        }
    } catch(error) {
        console.error('Error getting swos link.b', error)
    }
    setTimeout(getPortStatus, SwitchPollTime)
}

async function getMacAddressTable() {
    try {
        let response = await httpClient.fetch(`http://${options.ip}/!dhost.b`)
        let body = await response.text()
        let parsedData = eval('(' + body + ')')

        Object.keys(SwitchData).forEach(function (key) {
            SwitchData[key].ConnectedMacs = []
        })

        for (let i = 0; i < parsedData.length; i++) {
            if (SwitchData[parsedData[i].prt]) {
                SwitchData[parsedData[i].prt].ConnectedMacs.push(formatMAC(parsedData[i].adr))
            }
        }
    } catch(error) {
        console.error('Error getting swos !dhost.b', error)
    }
    setTimeout(getMacAddressTable, SwitchPollTime)
}

async function getMulticastSources() {
    try {
        let response = await httpClient.fetch(`http://${options.ip}/!igmp.b`)
        let body = await response.text()
        let parsedData = eval('(' + body + ')')

        Object.keys(SwitchData).forEach(function (key) {
            SwitchData[key].IGMP.Groups = {}
        })

        for (let i = 0; i < parsedData.length; i++) {
            let ip = convertNumberToIp(parsedData[i].addr)
            for (let j in SwitchData) {
                SwitchData[j].IGMP.Groups[ip] = (parsedData[i].prts & (1 << parseInt(j))) > 0
            }
        }
    } catch(error) {
        console.error('Error getting swos !igmp.b', error)
    }
    setTimeout(getMacAddressTable, SwitchPollTime)
}

async function getSystemInfo() {
    try {
        let response = await httpClient.fetch(`http://${options.ip}/sys.b`)
        let body = await response.text()
        let parsedData = eval('(' + body + ')')

        if (parsedData.id) Switch.Name = convertMikrotikString(parsedData.id)
        if (parsedData.temp) Switch.System.CPUTemps = [parsedData.temp]
        if (parsedData.mac) Switch.Mac = parsedData.mac
        if (parsedData.igmp) {
            Switch.Multicast = 'on'
        } else {
            Switch.Multicast = 'off'
        }
    } catch(error) {
        console.error('Error getting swos sys.b', error)
    }
    setTimeout(getSystemInfo, SwitchPollTime)
}

async function getVlans() {
    try {
        let response = await httpClient.fetch(`http://${options.ip}/vlan.b`)
        let body = await response.text()
        let parsedDataVlan = eval('(' + body + ')')

        VLANDefs = {}
        for (let i = 0; i < parsedDataVlan.length; i++) {
            VLANDefs[parsedDataVlan[i].vid] = {
                snooping: parsedDataVlan[i].igmp == 1,
                memberMask: parsedDataVlan[i].mbr,
            }
        }
    } catch(error) {
        console.error('Error getting swos vlan.b', error)
    }
    try {
        let response = await httpClient.fetch(`http://${options.ip}/fwd.b`)
        let body = await response.text()
        let parsedDataFwd = eval('(' + body + ')')

        for (let i = 0; i < parsedDataFwd.vlni.length; i++) {
            if (SwitchData[i]) {
                let tagged = []
                let untagged = []

                // VLAN Receive "any"
                if (parsedDataFwd.vlni[i] == 0) {
                    untagged = [parsedDataFwd.dvid[i]]
                    for (let id in VLANDefs) {
                        if (id != parsedDataFwd.dvid[i]) tagged.push(id)
                    }
                }
                // VLAN Receive "only tagged"
                if (parsedDataFwd.vlni[i] == 1) {
                    for (let id in VLANDefs) {
                        tagged.push(id)
                    }
                }
                // VLAN Receive "only untagged"
                if (parsedDataFwd.vlni[i] == 2) {
                    untagged = [parsedDataFwd.dvid[i]]
                }
                SwitchData[i].Vlan.Tagged = tagged
                SwitchData[i].Vlan.Untagged = untagged
            }
        }
    } catch (error) {
        console.error('Error getting swos fwd.b', error)
    }
    setTimeout(getVlans, SwitchPollTime)
}


async function StartSwitchDatamine() {
    await getSystemInfo()
    await getPortStatus()
    await getStats()
    await getVlans()
    await getMacAddressTable()
    await getMulticastSources()

    sendUpdate()
}

setTimeout(StartSwitchDatamine, 5000)
console.log('Starting SwOS listener')
