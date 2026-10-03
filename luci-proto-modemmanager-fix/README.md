# luci-proto-modemmanager-fix

用 QModem 信息页的呈现方式重做 **ModemManager 的 LuCI 蜂窝网络信息页**
（`状态 → 蜂窝网络`），并带上**移远模组的拨号修复**。整包即一个可编译的
OpenWrt 软件包源码：替换原 `luci-proto-modemmanager`，不与其共存。

## 一、信息页

呈现方式取自 QModem 的信息页：每个分组是一个面板
（`fieldset.cbi-section.collapsible.draggable` + `h2.panel-title` + `table.table`），
每行 33% 标签格 + 值格。

- 面板可折叠、可拖动排序，顺序与折叠状态记在 localStorage
- 数值字段**同时给出数值与进度条**（QModem 只在悬浮提示里给）
- 缩写词用 `<abbr>` 悬浮说明；空值行自动隐藏
- 5 秒轮询刷新；拖动排序期间暂停刷新，避免打断操作

显示内容（全部来自 ModemManager）：

| 面板 | 内容 |
| --- | --- |
| Modem Info | 厂商/型号/固件、IMEI、设备标识、设备路径、驱动、插件、主端口、电源状态、状态、失败原因、解锁要求 |
| Network Registration | 本机号码、接入技术、运营商及代码、注册状态、分组域状态、信号质量（进度条） |
| Bearer N | 类型、接口、连接状态、APN、IP 类型、漫游、IP 方式、IPv4 地址/网关/DNS/MTU、IPv6、上下行速率、时长、连接错误 |
| Signal — <制式> | ModemManager 上报的各制式信号数值（RSSI/RSRP/RSRQ/SNR/…），数值 + 进度条 |
| SIM N | 激活、运营商及代码、ICCID、IMSI、SIM 类型、可移除性、eSIM 状态、EID、GID1/2 |

**刻意不显示的内容**（显示不了就不显示）：

- **小区位置（CID/LAC/MCC/MNC/TAC）**：ModemManager 取 3GPP 小区位置靠
  `AT+CREG?`/`AT+CEREG?`，RM500U-CNV 对这两条命令不返回任何内容（实测响应为空），
  而数据只在移远私有的 `AT+QENG="servingcell"` 里。经实测，本模组既没有
  Quectel QDU 的 AT-over-MBIM 通道、也没有 ATDS 服务（详见仓库 `patches/`），
  因此该面板整体移除，不再显示空面板或提示文案。
- **扩展信号值（RSRP/RSRQ/SNR）**：同一原因（`AT+QCSQ` 不支持）。面板只在
  ModemManager 真报出数值时才出现；本模组经 MBIM 只上报 RSSI 与 error-rate。

## 二、移远模组拨号修复

真机踩到的三个坑（`proto modemmanager` 接口）：

1. `network`(S20) 早于 `modemmanager`(S70) 启动，而协议处理器查不到模组就立即失败
   并把接口置为 unavailable，之后没有重试机制；
2. **LuCI 的接口表单保存后会丢掉 `option auto`** —— netifd 便不再自动拉起该接口，
   掉线后没有任何机制重拨（实测断开 5 分钟后仍是断的）；
3. `option force_connection` 未设置时，连接失败会执行 `proto_block_restart`
   （明确阻止自动重启）。

修复由两部分组成：

- **`/etc/init.d/wan-mm-wait`（看护循环）**：每 30 秒检查 `proto=modemmanager`
  的接口，不在 up、也不在 pending 时，等 ModemManager 发布模组后修正失效的模组路径
  （对象编号不固定）、`--enable` 并 `ifup`。开机自动拨号与掉线自动恢复是同一个机制。
  不想被看护：把该接口的 `option auto` 设为 `0`，或 `/etc/init.d/wan-mm-wait stop`。
- **`/etc/uci-defaults/99-wan-mm-wait`**：首次启动为 modemmanager 接口补齐
  `auto=1` 与 `force_connection=1`（只补缺省项，不覆盖用户显式设置），并启用看护、
  重启 rpcd 让扩展后的 ACL 生效。

实测效果：`ifdown wan` 注入故障后 55 秒自动恢复，模组重新成为主上行（metric 5）。

## 三、安装（在固件里替换原包）

本包提供原包的全部文件（信息页、数据层、接口编辑表单 `protocol/modemmanager.js`、
菜单、ACL），并声明 `PROVIDES:=luci-proto-modemmanager` 与
`CONFLICTS:=luci-proto-modemmanager`：

```sh
echo "src-link mmfix /home/aya/luci-proto-modemmanager-fix" >> feeds.conf
./scripts/feeds update -a && ./scripts/feeds install -a

echo "CONFIG_PACKAGE_luci-proto-modemmanager-fix=m" >> .config
echo "CONFIG_PACKAGE_luci-proto-modemmanager=n" >> .config
make defconfig && make
```

依赖原包名的其它组件不受影响（ACL 组名仍沿用 `luci-proto-modemmanager`）。
若不想用 CONFLICTS/PROVIDES，也可把同样这些文件按相同路径直接打进原包。

## 四、文件清单

```
Makefile                                                 包定义（PROVIDES/CONFLICTS 原包名）
htdocs/luci-static/resources/view/modemmanager/status.js 信息页（QModem 风格呈现）
htdocs/luci-static/resources/modemmanager_helper.js      数据层（mmcli -L/-m/-i/-b/--signal-get）
htdocs/luci-static/resources/protocol/modemmanager.js    接口编辑表单（上游原样，保证替换后仍可编辑）
root/usr/share/luci/menu.d/luci-proto-modemmanager.json  菜单（沿用原文件名/路径）
root/usr/share/rpcd/acl.d/luci-proto-modemmanager.json   ACL（在上游基础上增加 -b 与 --signal-get）
root/etc/init.d/wan-mm-wait                              看护：开机拨号 + 掉线自动恢复
root/etc/uci-defaults/99-wan-mm-wait                     补齐 auto/force_connection 并启用看护
```

## 五、验证状态

- 包在 OpenWrt 25.12.5 SDK（x86_64/musl）上**编译通过**，包内 8 个文件路径正确。
- 真机（iStoreOS 25.12.5 + Quectel RM500U-CNV）验证：页面取数与渲染逻辑
  （用真机 mmcli JSON 驱动）、6 类 mmcli 命令经 rpcd ACL 放行、看护的故障自愈。
- 受限于无浏览器环境，页面的实际 DOM/CSS 外观未经浏览器验证，JS 仅做语法与渲染逻辑校验。

## 六、调研产物（本项目内，不打包进固件）

本项目根目录下的 `patches/modemmanager/` 是排查「小区位置/扩展信号」时留下的产物与结论：
`0100-quectel-qeng-3gpp-location.patch`（改用 `+QENG` 的插件补丁，功能可用但会触发
ModemManager 的 AT 上下文崩溃，未采用）、`tools/mbimprobe.c`（MBIM 探针，
结论：本模组未声明 QDU/ATDS 服务，MBIM-AT 通道不可用）。这些**不打包进固件**。

## 七、许可证

本包以 **GNU 通用公共许可证第 2 版（GPLv2）** 授权发布，包元数据声明为 `PKG_LICENSE:=GPL-2.0`。

其中 `htdocs/luci-static/resources/protocol/modemmanager.js` 直接取自上游 LuCI 包 `luci-proto-modemmanager`（Apache-2.0），保留其原始许可；本包其余部分按 GPLv2 授权。

许可证全文见 GNU 官方：<https://www.gnu.org/licenses/old-licenses/gpl-2.0.txt>
