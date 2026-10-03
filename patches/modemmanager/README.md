# modemmanager quectel 插件补丁：让 3GPP 小区位置有值

## 解决什么问题

ModemManager 取 3GPP 小区位置（MCC/MNC/LAC/TAC/CID）靠的是 `AT+CREG?` /
`AT+CGREG?` / `AT+CEREG?` 的注册上报。部分移远模组**对这几条命令不返回任何内容**
（实测 RM500U-CNV：`AT+CREG?` 与 `AT+CEREG?` 的响应都是空字符串），于是
`mmcli -m 0 --location-get` 里 cid/lac/mcc/mnc/tac 全是 `--`，LuCI 的"蜂窝网络位置"
面板因此是空的 —— 不是页面问题，也不是配置问题：ModemManager 明明报
`capabilities/enabled = ["3gpp-lac-ci"]`。

数据其实存在，只是仅通过移远私有命令暴露：

```
AT+QENG="servingcell"
 -> +QENG: "servingcell","CONNECT","NR5G-SA","TDD",460,01,3DD420154,661,3D3100,633984,78,20,-87,-2,23,18,26,1
     （MCC 460 / MNC 01 / cellID 3DD420154 / TAC 3D3100）
```

## 补丁做了什么

新增解析器 `mm_quectel_parse_qeng_servingcell()`，并在 quectel 共享实现
（`mm-shared-quectel.c`，MBIM 与 QMI 两个类共用）里：启用 3GPP 位置源时**立即采集
一次**（位置马上有值）并**每 30 秒刷新**，把结果喂给 location 接口；关闭该位置源或
模组对象销毁时停止刷新。

字段位置按各制式的 `+QENG` 格式区分（已在真机核对 NR5G-SA，LTE/WCDMA/GSM 按官方
手册字段顺序）：

| 制式 | MCC | MNC | cellID | TAC/LAC |
| --- | --- | --- | --- | --- |
| `LTE` | 4 | 5 | 6（十六进制） | TAC 12（十六进制） |
| `NR5G-SA` | 4 | 5 | 6（十六进制） | TAC 8（十六进制） |
| `WCDMA`/`UMTS`/`GSM` | 3 | 4 | 6（十六进制） | LAC 5（十六进制） |

改动 3 个文件、221 行新增：

```
src/plugins/quectel/mm-modem-helpers-quectel.h   声明解析器
src/plugins/quectel/mm-modem-helpers-quectel.c   +QENG 解析与字段映射
src/plugins/quectel/mm-shared-quectel.c          采集、30 秒轮询、enable/disable 挂钩
```

## 应用方法

构建期（推荐，OpenWrt 会自动应用包的 `patches/` 目录）：

```sh
./scripts/feeds update -a && ./scripts/feeds install -a
cp patches/modemmanager/*.patch feeds/packages/net/modemmanager/patches/
make package/modemmanager/clean
make package/modemmanager/compile
```

注意 `feeds update` 可能清掉放进去的补丁，所以**每次 feeds 更新后重新拷贝**。

直接改源码树：

```sh
git clone --depth 1 --branch 1.24.0 https://gitlab.freedesktop.org/mobile-broadband/ModemManager.git
cd ModemManager && patch -p1 < .../0001-quectel-qeng-3gpp-location.patch
```

## 已知取舍

- 补丁只影响 quectel 插件。对于本来能正常响应 `+CEREG` 的移远模组，位置会改由
  `+QENG` 提供（同一数据源，语义一致）；若某型号的 `+QENG` 字段顺序不同导致解析
  失败，代码只记一条 debug 日志、不会改动已有位置，因此不会造成倒退。
- 轮询期间会持有模组对象引用以保证定时器回调安全；关闭 3GPP 位置源（或模组被
  disable，ModemManager 会先调 disable）即停止。
- 若模组固件不支持 `+QENG`，命令失败只记日志，行为与打补丁前一致。

## 当前状态：功能正确，但会让 ModemManager 崩溃 —— 暂不可用

**功能部分是好的**（真机日志证据，RM500U-CNV / Unicom）：

```
[modem0] AT command 'AT+QENG="servingcell"' run: +QENG: "servingcell","CONNECT","NR5G-SA","TDD",460,01,3DD420154,661,3D3100,...
[modem0] (shared-quectel) 3GPP location operator code from +QENG: '46001'
[modem0] (shared-quectel) 3GPP location from +QENG: lac 0, tac 4010240, cell id 16596992340
[modem0] 3GPP location updated (MCCMNC: '46001', location area code: '0000', tracking area code: '3D3100', cell ID: '3DD420154')
```

解析与写入都正确，`mmcli --location-get` 本应出现 MCC 460 / MNC 01 / TAC 3D3100 / CID 3DD420154。

**阻塞问题**：命令发出后 ModemManager 立刻 SIGSEGV，调用栈落在它自己的
AT 命令上下文释放里：

```
Program terminated with signal SIGSEGV, Segmentation fault.
#7  0x0000000000469716 in at_command_context_free ()
```

该函数（`src/mm-base-modem-at.c`）会做 `teardown_port (ctx->port); g_object_unref (ctx->port);`
—— 现象符合 `ctx->port` 悬垂（端口对象在 ModemManager 关闭/重建端口的过程中被销毁，
而命令上下文仍持有它）。

已尝试并**全部崩溃**的四种时序：

| 尝试 | 结果 |
| --- | --- |
| 在 `enable_location_gathering` 回调里立即查询 | 崩溃 |
| 延迟 2 秒后再查询 | 崩溃 |
| 闸门：模组状态 ≥ `ENABLED` 才查询 | 崩溃 |
| 闸门：模组状态 ≥ `REGISTERED` 才查询 | 崩溃 |

也就是说，只要从插件侧经 `mm_base_modem_at_command()` 下发这条命令，就会踩到
ModemManager 的 AT 上下文生命周期问题（同文件里 ModemManager 自己也这么用，
因此更像它内部的时序缺陷，而不是本补丁的用法错误）。

### 复现与取证方法（供继续排查）

```sh
# 让 init 管理的 ModemManager 也产生 core（平时 RLIMIT_CORE=0）
sed -i '/ModemManager "$@"/i\        ulimit -c unlimited 2>/dev/null' /usr/sbin/ModemManager-wrapper
# 换上打补丁的、未 strip 的二进制，重启后即崩溃
cp ModemManager /usr/sbin/ModemManager && /etc/init.d/modemmanager restart
ls -t /tmp/*.core | head -1
gdb -batch -ex 'bt' /usr/sbin/ModemManager <core>
# 收尾（务必恢复）
cp /root/ModemManager.orig /usr/sbin/ModemManager
cp /root/wrapper.orig /usr/sbin/ModemManager-wrapper
/etc/init.d/modemmanager restart && /etc/init.d/wan-mm-wait restart
```

注意：ModemManager 默认不做设备扫描（日志 `unsupported automatic device scan`），
模组发现依赖热插拔脚本回放缓存事件；手动跑 `/usr/sbin/ModemManager` 时必须让
`/etc/hotplug.d/{net,tty,wwan}/25-modemmanager-*` 保持可执行。

### 可选的后续路线

1. **继续修这个崩溃**：需要 ModemManager 的调试符号定位 `ctx->port` 为何悬垂，
   或直接把上面的复现步骤报给上游（这属于它 AT 层的生命周期缺陷）。
2. **绕开 ModemManager 的 AT 机制**：先给模组腾出一个空闲 AT 口
   （`AT+QCFG="usbcfg"` 调整 USB 配置，会重启模组），再用独立脚本 / rpcd 方法查询
   `AT+QENG`，页面从那里取小区位置与完整信号值（RSRP/RSRQ/SNR）。
3. **暂不填这些字段**：`luci-proto-modemmanager-fix` 的信息页已经会在小区位置面板
   给出解释行，用户不会误以为页面坏了。

## 验证

- 补丁在 ModemManager **1.24.0** 原始源码上可干净应用（`git apply --check` 通过），
  并被 OpenWrt 构建系统自动应用、编译通过（x86_64 / musl / 25.12.5 SDK）。
- 功能正确性见上面的真机日志；**当前因上述崩溃不可用于生产**。

## 附：另一种拨号修复（modemmanager-wait-for-modem.patch）

`modemmanager-wait-for-modem.patch` 是给上游 `modemmanager` 包打的补丁：它修改
`files/lib/netifd/proto/modemmanager.sh`，在协议处理器里加入「等待 ModemManager
发布模组」的循环（可用 `option mm_wait` 调整秒数），从根因上解决 network(S20) 早于
modemmanager(S70) 导致的开机不拨号。

它与本项目的看护脚本 `wan-mm-wait` 解决同一问题，两者**择一即可**：

- 用看护脚本（本项目默认）：不动上游包，还能覆盖「掉线后无人重拨」的场景；
- 用本补丁：只修开机时序，掉线恢复仍依赖 ModemManager 自身的 connection.d 回调。

应用方式（构建期）：

```sh
cp patches/modemmanager/modemmanager-wait-for-modem.patch \
   feeds/packages/net/modemmanager/patches/
make package/modemmanager/clean && make package/modemmanager/compile
```
