'use strict';
'require baseclass';
'require fs';

// ModemManager 数据层（上游基础上增加承载/bearer 查询）。
return baseclass.extend({
_mmcliBin: '/usr/bin/mmcli',
_emptyStringValue: '--',

_parseIndex: function(dbusPath) {
var index = dbusPath.split('/').slice(-1);
return parseInt(index);
},

_parseOutput: function(output) {
try {
return this._removeEmptyStrings(JSON.parse(output));
}
catch (err) {
return null;
}
},

_removeEmptyStrings: function(obj) {
if (obj == null)
return obj;

if (typeof obj == 'string') {
if (obj == this._emptyStringValue)
obj = null;
}
else if (Array.isArray(obj)) {
obj = obj.map(L.bind(function(it) {
return this._removeEmptyStrings(it);
}, this));
}
else {
Object.keys(obj).forEach(L.bind(function(key) {
obj[key] = this._removeEmptyStrings(obj[key]);
}, this));
}

return obj;
},

getModems: function() {
return fs.exec_direct(this._mmcliBin, [ '-L', '-J' ]).then(L.bind(function(res) {
var json = this._parseOutput(res);
if (json == null)
return [];

return Promise.all((json['modem-list'] || []).map(L.bind(function(modem) {
var index = this._parseIndex(modem);
return isNaN(index) ? null : this.getModem(index);
}, this)));
}, this));
},

getModem: function(index) {
return fs.exec_direct(this._mmcliBin, [ '-m', index, '-J' ]).then(L.bind(function(modem) {
return this._parseOutput(modem);
}, this));
},

getModemSims: function(modem) {
var slots = modem.generic['sim-slots'] || [];
var sim = modem.generic.sim;

if (sim != null && slots.indexOf(sim) < 0)
slots = slots.concat([ sim ]);

return Promise.all(slots.map(L.bind(function(slot) {
var index = this._parseIndex(slot);
return isNaN(index) ? null : this.getSim(index);
}, this)));
},

getSim: function(index) {
return fs.exec_direct(this._mmcliBin, [ '-i', index, '-J' ]).then(L.bind(function(sim) {
return this._parseOutput(sim);
}, this));
},

// 本包新增：承载明细（APN / IP / 网关 / DNS）
getModemBearers: function(modem) {
return Promise.all((modem.generic.bearers || []).map(L.bind(function(bearer) {
var index = this._parseIndex(bearer);
return isNaN(index) ? null : this.getBearer(index);
}, this)));
},

getBearer: function(index) {
return fs.exec_direct(this._mmcliBin, [ '-b', index, '-J' ]).then(L.bind(function(bearer) {
return this._parseOutput(bearer);
}, this));
},

// 本包新增：各制式的信号数值（RSRP/RSRQ/SNR/RSSI 等）
getModemSignal: function(modem) {
var index = this._parseIndex(modem['dbus-path']);
return fs.exec_direct(this._mmcliBin, [ '-m', index, '--signal-get', '-J' ]).then(L.bind(function(signal) {
return this._parseOutput(signal);
}, this));
}
});
