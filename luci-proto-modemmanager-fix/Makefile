#
# 用 QModem 风格重做 ModemManager 的 LuCI 蜂窝网络信息页，并附带开机自动拨号触发。
#
# 本包与 luci-proto-modemmanager 互斥（CONFLICTS）并声明 PROVIDES 它，因此在固件
# 配置里选中本包、取消原包，即可在编译阶段完整替换掉原页面，而依赖原包名的其它
# 组件不受影响（ACL 组名仍沿用 luci-proto-modemmanager）。
#
include $(TOPDIR)/rules.mk

PKG_NAME:=luci-proto-modemmanager-fix
PKG_VERSION:=1.0.0
PKG_RELEASE:=1
PKG_LICENSE:=GPL-2.0
PKG_MAINTAINER:=local

include $(INCLUDE_DIR)/package.mk

define Package/$(PKG_NAME)
  SECTION:=luci
  CATEGORY:=LuCI
  SUBMENU:=3. Applications
  TITLE:=ModemManager cellular page in QModem style (+ boot auto-dial)
  DEPENDS:=+luci-base +modemmanager +rpcd-mod-file
  PKGARCH:=all
  PROVIDES:=luci-proto-modemmanager
  CONFLICTS:=luci-proto-modemmanager
endef

define Package/$(PKG_NAME)/description
 Replaces the stock ModemManager cellular information page with a QModem
 style presentation: collapsible, drag-reorderable panels, percent progress
 bars, abbreviation tooltips and hidden empty rows, while keeping all
 ModemManager specific information (modem state, failure reason, unlock
 state, drivers and ports, registration, cell location, bearers and SIMs).
 Also ships a boot trigger so the modem dials automatically, which the stock
 protocol handler does not do because network comes up before ModemManager.
endef

define Build/Compile
endef

define Package/$(PKG_NAME)/install
	$(INSTALL_DIR) $(1)/www/luci-static/resources/view/modemmanager
	$(INSTALL_DATA) ./htdocs/luci-static/resources/view/modemmanager/status.js \
		$(1)/www/luci-static/resources/view/modemmanager/status.js
	$(INSTALL_DIR) $(1)/www/luci-static/resources
	$(INSTALL_DATA) ./htdocs/luci-static/resources/modemmanager_helper.js \
		$(1)/www/luci-static/resources/modemmanager_helper.js
	$(INSTALL_DIR) $(1)/www/luci-static/resources/protocol
	$(INSTALL_DATA) ./htdocs/luci-static/resources/protocol/modemmanager.js \
		$(1)/www/luci-static/resources/protocol/modemmanager.js
	$(INSTALL_DIR) $(1)/usr/share/luci/menu.d
	$(INSTALL_DATA) ./root/usr/share/luci/menu.d/luci-proto-modemmanager.json \
		$(1)/usr/share/luci/menu.d/luci-proto-modemmanager.json
	$(INSTALL_DIR) $(1)/usr/share/rpcd/acl.d
	$(INSTALL_DATA) ./root/usr/share/rpcd/acl.d/luci-proto-modemmanager.json \
		$(1)/usr/share/rpcd/acl.d/luci-proto-modemmanager.json
	$(INSTALL_DIR) $(1)/etc/init.d
	$(INSTALL_BIN) ./root/etc/init.d/wan-mm-wait $(1)/etc/init.d/wan-mm-wait
	$(INSTALL_DIR) $(1)/etc/uci-defaults
	$(INSTALL_BIN) ./root/etc/uci-defaults/99-wan-mm-wait $(1)/etc/uci-defaults/99-wan-mm-wait
endef

$(eval $(call BuildPackage,$(PKG_NAME)))
