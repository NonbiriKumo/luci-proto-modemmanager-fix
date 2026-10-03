'use strict';
'require view';
'require dom';
'require poll';
'require ui';
'require modemmanager_helper as helper';

/*
 * ModemManager 蜂窝网络信息页（呈现方式取自 QModem 的信息页）。
 *
 * 每个信息分组是一个可折叠、可拖动排序的面板：
 *   fieldset.cbi-section.collapsible.draggable > h2.panel-title + table.table
 * 每行是 33% 宽的标签格 + 值格；数值字段渲染成进度条；缩写词用 <abbr> 悬浮说明；
 * 空值行自动隐藏；面板顺序与折叠状态记在 localStorage。
 *
 * 信息仍是 ModemManager 自己的：模组/固件/IMEI/设备标识、电源与状态、失败原因、
 * 解锁要求、驱动与端口、注册与接入技术、信号质量、小区位置、承载明细、SIM 属性。
 */

var SECTION_CLASS = 'cbi-section collapsible draggable';

// 拖动排序期间不要重建面板，否则会把手中的拖动打断
var draggingSection = false;

function InfoTable() {
this.rows = [];
this.fieldset = E('fieldset', { 'class': SECTION_CLASS, 'draggable': 'true' });
this.titleNode = E('h2', { 'class': 'panel-title' });
this.tbody = E('tbody', { 'style': 'width: 100%' });
this.fieldset.appendChild(this.titleNode);
this.fieldset.appendChild(E('table', { 'class': 'table' }, [ this.tbody ]));
}

InfoTable.prototype = {
setTitle: function(title) {
this.titleNode.textContent = title;
return this;
},

slot: function(index) {
while (this.rows.length <= index) {
var left = E('td', { 'class': 'td left', 'width': '33%' });
var right = E('td', { 'class': 'td' });
var tr = E('tr', { 'class': 'tr' }, [ left, right ]);

this.tbody.appendChild(tr);
this.rows.push({ tr: tr, left: left, right: right });
}

return this.rows[index];
},

// rows: [ { label, value, abbr, progress } ]
// 全部为空时用 emptyHint 显示一行说明，避免只剩一个空面板
setData: function(rows, emptyHint) {
var used = 0;

for (var i = 0; i < rows.length; i++) {
var spec = rows[i];
var hasProgress = (spec.progress != null);
var value = spec.value;

// 空值行隐藏（与 QModem 的信息页一致）
if (!hasProgress && (value == null || value === '' ||
    (Array.isArray(value) && value.length === 0)))
continue;

var slot = this.slot(used++);

slot.left.textContent = '';
slot.left.appendChild(spec.abbr
? E('abbr', { 'title': spec.abbr }, [ spec.label ])
: document.createTextNode(spec.label));

slot.right.textContent = '';
if (hasProgress) {
var pct = Math.max(0, Math.min(100, spec.progress));

// 数值本身也要看得见（QModem 只在悬浮提示里给），进度条内联在右侧
if (spec.value != null)
slot.right.appendChild(E('span', { 'style': 'margin-right: 8px' },
[ String(spec.value) ]));

slot.right.appendChild(E('div', {
'class': 'cbi-progressbar',
'style': 'display: inline-block; vertical-align: middle; width: 55%; min-width: 80px',
'title': spec.label
}, [ E('div', { 'style': 'width: %d%%'.format(pct) }) ]));
}
else {
				var text = Array.isArray(value)
					? value.filter(function(v) { return v != null; }).join(', ')
					: String(value);
				slot.right.appendChild(document.createTextNode(text));
}

slot.tr.style.display = '';
}

// 轮询后数据变少时，多余的旧行要隐藏
for (var j = used; j < this.rows.length; j++)
this.rows[j].tr.style.display = 'none';

// 一条有效数据都没有：给出行内说明（否则只剩标题，像是坏了）
if (used === 0 && emptyHint) {
var hint = this.slot(0);
hint.left.textContent = '';
hint.right.textContent = '';
hint.right.appendChild(E('em', {}, [ emptyHint ]));
hint.tr.style.display = '';
}

return this;
}
};

// ------------------------------------------------------------------ 数值格式

// 信号强度到 0-100% 的常用映射范围（与 QModem 页面的取值一致）
var SIGNAL_RANGE = {
'rssi': { min: -113, max: -51, unit: 'dBm' },
'rsrp': { min: -140, max: -44, unit: 'dBm' },
'rsrq': { min: -20, max: -3, unit: 'dB' },
'snr': { min: -20, max: 30, unit: 'dB' },
'sinr': { min: -20, max: 30, unit: 'dB' },
'rscp': { min: -120, max: -25, unit: 'dBm' },
'ecio': { min: -20, max: 0, unit: 'dB' },
'io': { min: -120, max: -60, unit: 'dBm' },
'error-rate': { min: 0, max: 100, unit: '%' }
};

var SIGNAL_NAME = {
'rssi': 'RSSI', 'rsrp': 'RSRP', 'rsrq': 'RSRQ', 'snr': 'SNR',
'sinr': 'SINR', 'rscp': 'RSCP', 'ecio': 'Ec/Io', 'io': 'Io',
'error-rate': _('Error Rate')
};

var TECH_NAME = {
'5g': '5G NR', 'lte': 'LTE', 'umts': 'UMTS', 'gsm': 'GSM',
'cdma1x': 'CDMA 1x', 'evdo': 'EV-DO'
};

function formatSpeed(value) {
	var bps = parseInt(value);

	if (isNaN(bps) || bps <= 0)
		return null;
	if (bps >= 1000000)
		return '%.1f Mbps'.format(bps / 1000000);
	if (bps >= 1000)
		return '%.0f kbps'.format(bps / 1000);

	return '%d bps'.format(bps);
}

function formatDuration(value) {
	var sec = parseInt(value);

	if (isNaN(sec) || sec <= 0)
		return null;

	var h = Math.floor(sec / 3600);
	var m = Math.floor((sec % 3600) / 60);
	var left = sec % 60;

	if (h > 0)
		return '%dh %dm'.format(h, m);
	if (m > 0)
		return '%dm %ds'.format(m, left);

	return '%ds'.format(left);
}


// ------------------------------------------------------------------ 面板内容

function modemPanels(modem) {
var generic = (modem.modem && modem.modem.generic) || {};
var three = (modem.modem && modem.modem['3gpp']) || {};

var signal = generic['signal-quality'] ? parseInt(generic['signal-quality'].value) : NaN;
var panels = [];

panels.push({
id: 'modem-info',
title: _('Modem Info'),
rows: [
{ label: _('Manufacturer'), value: generic.manufacturer },
{ label: _('Model'), value: generic.model },
{ label: _('Revision'), value: generic.revision },
{ label: _('IMEI'), abbr: _('International Mobile Station Equipment Identity'),
  value: three.imei },
{ label: _('Equipment Identifier'), abbr: _('Equipment identifier reported by the modem'),
  value: generic['equipment-identifier'] },
{ label: _('Device Identifier'), value: generic['device-identifier'] },
{ label: _('Device'), value: generic.device },
{ label: _('Drivers'), value: generic.drivers },
{ label: _('Plugin'), value: generic.plugin },
{ label: _('Primary Port'), value: generic['primary-port'] },
{ label: _('Power State'), value: generic['power-state'] },
{ label: _('State'), value: generic.state },
{ label: _('Failed Reason'), value: generic['state-failed-reason'] },
{ label: _('Unlock Required'), value: generic['unlock-required'] }
]
});

panels.push({
id: 'network-registration',
title: _('Network Registration'),
rows: [
{ label: _('Mobile Number'), value: generic['own-numbers'] },
{ label: _('Access Technologies'), value: generic['access-technologies'] },
{ label: _('Operator'), value: three['operator-name'] },
{ label: _('Operator Code'), value: three['operator-code'] },
{ label: _('Registration State'), value: three['registration-state'] },
{ label: _('Packet Service State'), value: three['packet-service-state'] },
{ label: _('Signal Quality'), progress: isNaN(signal) ? null : signal }
]
});

	(modem.bearers || []).forEach(function(bearer, index) {
		var data = (bearer && bearer.bearer) || {};
		var status = data.status || {};
		var props = data.properties || {};
		var ipv4 = data['ipv4-config'] || {};
		var ipv6 = data['ipv6-config'] || {};
		var stats = data.stats || {};
		var err = status['connection-error'] || {};

		panels.push({
			id: 'bearer-' + (index + 1),
			title: _('Bearer %d').format(index + 1),
			rows: [
				{ label: _('Type'), value: data.type },
				{ label: _('Interface'), value: status.interface },
				{ label: _('Connected'), value: status.connected },
				{ label: _('APN'), value: props.apn },
				{ label: _('IP Type'), value: props['ip-type'] },
				{ label: _('Roaming'), value: props.roaming },
				{ label: _('Username'), value: props.user },
				{ label: _('IP Method'), value: ipv4.method },
				{ label: _('IPv4 Address'), abbr: _('Address and prefix length'),
				  value: ipv4.address ? '%s/%s'.format(ipv4.address, ipv4.prefix) : null },
				{ label: _('IPv4 Gateway'), value: ipv4.gateway },
				{ label: _('IPv4 DNS'), value: ipv4.dns },
				{ label: _('MTU'), value: ipv4.mtu },
				{ label: _('IPv6 Address'),
				  value: ipv6.address ? '%s/%s'.format(ipv6.address, ipv6.prefix) : null },
				{ label: _('IPv6 Gateway'), value: ipv6.gateway },
				{ label: _('IPv6 DNS'), value: ipv6.dns },
				{ label: _('Uplink Speed'), value: formatSpeed(stats['uplink-speed']) },
				{ label: _('Downlink Speed'), value: formatSpeed(stats['downlink-speed']) },
				{ label: _('Duration'), value: formatDuration(stats.duration) },
				{ label: _('Connection Error'), value: err.name }
			]
		});
	});

	// ---- 各制式信号数值（ModemManager 的 --signal-get）----
var signalData = (modem.signal && modem.signal.modem && modem.signal.modem.signal) || {};
var signalPanels = 0;

Object.keys(signalData).forEach(function(tech) {
if (tech === 'refresh' || tech === 'threshold')
return;

var metrics = signalData[tech] || {};
var rows = [];

Object.keys(metrics).forEach(function(name) {
var raw = metrics[name];

if (raw == null || raw === '')
return;

var range = SIGNAL_RANGE[name];
var num = parseFloat(raw);

if (range && !isNaN(num)) {
var pct = ((num - range.min) / (range.max - range.min)) * 100;
rows.push({
label: SIGNAL_NAME[name] || name,
value: raw + ' ' + range.unit,
progress: Math.max(0, Math.min(100, pct))
});
}
else {
rows.push({ label: SIGNAL_NAME[name] || name, value: raw });
}
});

if (rows.length) {
signalPanels++;
panels.push({
id: 'signal-' + tech,
title: _('Signal') + ' \u2014 ' + (TECH_NAME[tech] || tech),
rows: rows
});
}
});

// 没有任何信号数值时给出提示（ModemManager 需要开启信号刷新）
(modem.sims || []).forEach(function(sim, index) {
		var props = (sim && sim.sim && sim.sim.properties) || {};

		panels.push({
			id: 'sim-' + (index + 1),
			title: _('SIM %d').format(index + 1),
			rows: [
				{ label: _('Active'), value: props.active },
				{ label: _('Operator Name'), value: props['operator-name'] },
				{ label: _('Operator Code'), value: props['operator-code'] },
				{ label: _('ICCID'), abbr: _('Integrated Circuit Card Identifier'), value: props.iccid },
				{ label: _('IMSI'), abbr: _('International Mobile Subscriber Identity'), value: props.imsi },
				{ label: _('SIM Type'), value: props['sim-type'] },
				{ label: _('Removability'), value: props.removability },
				{ label: _('ESIM Status'), abbr: _('Embedded SIM status'), value: props['esim-status'] },
				{ label: _('EID'), abbr: _('Embedded identity document'), value: props.eid },
				{ label: 'GID1', value: props.gid1 },
				{ label: 'GID2', value: props.gid2 }
			]
		});
	});

return panels;
}

// ------------------------------------------------- 面板排序/折叠状态的本地记忆

function storageKey(kind, modemId, name) {
return 'mm_' + kind + '_' + modemId + (name ? '_' + name : '');
}

// --------------------------------------------------------------- view 定义

return view.extend({
load: function() {
return helper.getModems().then(function(modems) {
return Promise.all(modems.filter(function(m) { return m != null; }).map(function(modem) {
return helper.getModemSims(modem).then(function(sims) {
modem.sims = sims.filter(function(s) { return s != null; });
return helper.getModemBearers(modem).then(function(bearers) {
modem.bearers = bearers.filter(function(b) { return b != null; });
return helper.getModemSignal(modem).then(function(signal) {
modem.signal = signal;
return modem;
});
});
});
}));
});
},

renderPanels: function(modems) {
var self = this;
var wrapper = E('div', {}, E('div'));

modems.forEach(function(modem, index) {
var generic = (modem.modem && modem.modem.generic) || {};
var modemId = generic.device || ('modem%d'.format(index));
var title = '%s %s'.format(generic.manufacturer || '', generic.model || '').trim() ||
            _('Modem %d').format(index + 1);
var container = E('div', { 'style': 'width: 100%' });
var panels = modemPanels(modem);

// 按记忆的顺序排列（未记录的排在后面，保持原顺序）
var saved = [];
try {
saved = JSON.parse(localStorage.getItem(storageKey('order', modemId))) || [];
}
catch (e) { saved = []; }

panels.sort(function(a, b) {
var ia = saved.indexOf(a.id), ib = saved.indexOf(b.id);
if (ia < 0 && ib < 0) return 0;
if (ia < 0) return 1;
if (ib < 0) return -1;
return ia - ib;
});

panels.forEach(function(panel) {
var table = new InfoTable().setTitle(panel.title).setData(panel.rows, panel.hint);

if (localStorage.getItem(storageKey('collapsed', modemId, panel.id)) === 'true')
table.fieldset.classList.add('collapsed');

self.attachSectionHandlers(table.fieldset, modemId, container);
container.appendChild(table.fieldset);
});

wrapper.firstElementChild.appendChild(
E('div', { 'data-tab': modemId, 'data-tab-title': title }, [ container ]));
});

if (modems.length > 1)
ui.tabs.initTabGroup(wrapper.firstElementChild.childNodes);

return wrapper;
},

attachSectionHandlers: function(fieldset, modemId, container) {
var title = fieldset.querySelector('.panel-title');
var dragging = false;

title.addEventListener('click', function() {
if (fieldset.classList.contains('dragging'))
return;

fieldset.classList.toggle('collapsed');
localStorage.setItem(storageKey('collapsed', modemId,
fieldset.querySelector('.panel-title').textContent),
fieldset.classList.contains('collapsed') ? 'true' : 'false');
});

fieldset.addEventListener('dragstart', function(ev) {
dragging = true;
draggingSection = true;
fieldset.classList.add('dragging');
ev.dataTransfer.effectAllowed = 'move';
});

fieldset.addEventListener('dragend', function() {
dragging = false;
draggingSection = false;
fieldset.classList.remove('dragging');
container.querySelectorAll('.' + SECTION_CLASS.split(' ').join('.')).forEach(function(el) {
el.classList.remove('drag-over');
});
});

fieldset.addEventListener('dragover', function(ev) {
ev.preventDefault();
ev.dataTransfer.dropEffect = 'move';
if (container.querySelector('.dragging') !== fieldset)
fieldset.classList.add('drag-over');
});

fieldset.addEventListener('dragleave', function() {
fieldset.classList.remove('drag-over');
});

fieldset.addEventListener('drop', function(ev) {
ev.preventDefault();
fieldset.classList.remove('drag-over');

var dragged = container.querySelector('.dragging');
if (!dragged || dragged === fieldset)
return;

container.insertBefore(dragged, fieldset);

var order = [];
container.querySelectorAll('fieldset').forEach(function(section) {
order.push(section.querySelector('.panel-title').textContent);
});
localStorage.setItem(storageKey('order', modemId), JSON.stringify(order));
});
},

render: function(modems) {
var content = E([ E('h2', {}, [ _('Cellular Network') ]), E('div') ]);
var container = content.lastElementChild;

dom.content(container, this.renderPanels(modems));

poll.add(L.bind(function() {
if (draggingSection)
return;

return this.load().then(L.bind(function(list) {
dom.content(container, this.renderPanels(list));
}, this));
}, this), 5);

return content;
},

handleSave: null,
handleSaveApply: null,
handleReset: null
});


