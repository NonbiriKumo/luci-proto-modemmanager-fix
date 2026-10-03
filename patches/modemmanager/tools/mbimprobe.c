/*
 * mbimprobe —— 只读的 MBIM 探测工具
 *
 * 目的：查清一块 MBIM 模组对外声明的服务与 CID，并验证两条「AT over MBIM」通道：
 *   1) QDU 服务 (6427015f-579d-48f5-8c54-f43ed1e76f83) CID 8、SET 模式
 *      —— 移远官方 QMbimAT 就是用它把 AT 指令塞进标准 MBIM 包
 *   2) ATDS 服务 (5967bdcc-7fd2-49a2-9f5c-b2e70e527db3) CID 2 位置查询
 *      —— ModemManager 原生支持的小区位置来源
 *
 * 帧格式要点（对照 libmbim 的 mbim-message.c：命令帧比 OPEN 多一个 fragment header）：
 *   命令 (MessageType=3)：
 *     0 u32 MessageType  4 u32 MessageLength  8 u32 TransactionId
 *     12 u32 FragmentTotal(=1)  16 u32 FragmentCurrent(=0)
 *     20 16B ServiceId  36 u32 CommandId  40 u32 CommandType
 *     44 u32 InformationBufferLength  48... InformationBuffer
 *   命令应答 (0x80000003)：同样带 fragment header
 *     20 16B ServiceId  36 u32 CommandId  40 u32 Status  44 u32 Length  48... Buffer
 *   OPEN(1)/OPEN_DONE(0x80000001)、CLOSE(2)/CLOSE_DONE(0x80000002)：无 fragment header
 *   功能错误 (0x80000004)：12 起是 u32 错误码
 *
 * 只做查询，不修改模组任何配置。运行前须停掉 ModemManager 并杀掉占用该设备节点的
 * mbim-proxy，否则帧会被抢走。
 *
 * 编译：
 *   x86_64-openwrt-linux-musl-gcc -static -O2 -I$TOOLCHAIN/include -o mbimprobe mbimprobe.c
 */

#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <stdint.h>
#include <unistd.h>
#include <fcntl.h>
#include <errno.h>
#include <poll.h>
#include <endian.h>

#define MBIM_OPEN_MSG       0x00000001
#define MBIM_OPEN_DONE      0x80000001
#define MBIM_CLOSE_MSG      0x00000002
#define MBIM_CLOSE_DONE     0x80000002
#define MBIM_COMMAND_MSG    0x00000003
#define MBIM_COMMAND_DONE   0x80000003
#define MBIM_FUNCTION_ERROR 0x80000004

#define CMD_QUERY 0
#define CMD_SET   1

/* 命令帧头部长度（含 8 字节 fragment header） */
#define CMD_HDR_LEN 48

static const uint8_t UUID_BASIC_CONNECT[16] = { 0xa2,0x89,0xcc,0x33,0xbc,0xbb,0x8b,0x4f,0xb6,0xb0,0x13,0x3e,0xc2,0xaa,0xe6,0xdf };
static const uint8_t UUID_QDU[16]           = { 0x64,0x27,0x01,0x5f,0x57,0x9d,0x48,0xf5,0x8c,0x54,0xf4,0x3e,0xd1,0xe7,0x6f,0x83 };
static const uint8_t UUID_ATDS[16]          = { 0x59,0x67,0xbd,0xcc,0x7f,0xd2,0x49,0xa2,0x9f,0x5c,0xb2,0xe7,0x0e,0x52,0x7d,0xb3 };

#define CID_DEVICE_SERVICES 16
#define CID_QDU_AT_COMMAND   8
#define CID_ATDS_LOCATION    2

static int      fd = -1;
static uint32_t txid = 1;

struct svc_name { const char *uuid; const char *name; };
static const struct svc_name KNOWN[] = {
	{ "a289cc33-bcbb-8b4f-b6b0-133ec2aae6df", "basic-connect" },
	{ "3d01dcc5-fef5-4d05-0d3a-bef7058e9aaf", "ms-basic-connect-extensions" },
	{ "c2f6588e-f037-4bc9-8665-f4d44bd09367", "ms-uicc-low-level-access" },
	{ "533fbeeb-14fe-4467-9f90-33a223e56c3f", "sms" },
	{ "e550a0c8-5e82-479e-82f7-10abf4c3351f", "ussd" },
	{ "4bf38476-1e6a-41db-b1d8-bed289c25bdb", "phonebook" },
	{ "5967bdcc-7fd2-49a2-9f5c-b2e70e527db3", "ATDS (AT&T Device Services)" },
	{ "6427015f-579d-48f5-8c54-f43ed1e76f83", "QDU (Quectel Device Update)" },
	{ "838cf7fb-8d0d-4d7f-871e-d71dbefbb39b", "proxy-control (libmbim)" },
	{ "e9f7dea2-feaf-4009-93ce-90a3694103b6", "ms-firmware-id" },
	{ "883b7c26-985f-43fa-9804-27d7fb80959c", "ms-host-shutdown-device" },
	{ "68223d04-9f6c-4e0f-822d-28441fb72340", "ms-sar" },
	{ "d1a30bc2-f97a-6e43-bf65-c7e24fb0f0d3", "ext-qmux (QMI over MBIM)" },
	{ "2d0c12c9-0e6a-495a-915c-8d174fe5d63c", "qmbe" },
	{ "634618d3-a5b1-4fab-922f-a7ac9a69148c", "??（本次待查的未知服务）" },
	{ NULL, NULL }
};

static const char *svc_name(const char *uuid)
{
	int i;

	for (i = 0; KNOWN[i].uuid; i++)
		if (strcmp(KNOWN[i].uuid, uuid) == 0)
			return KNOWN[i].name;

	return "?（未知服务）";
}

static void uuid_to_str(const uint8_t *u, char out[40])
{
	snprintf(out, 40,
	         "%02x%02x%02x%02x-%02x%02x-%02x%02x-%02x%02x-%02x%02x%02x%02x%02x%02x",
	         u[0], u[1], u[2], u[3], u[4], u[5], u[6], u[7],
	         u[8], u[9], u[10], u[11], u[12], u[13], u[14], u[15]);
}

static uint32_t rd32(const uint8_t *p)
{
	uint32_t v;

	memcpy(&v, p, 4);
	return le32toh(v);
}

static void wr32(uint8_t *p, uint32_t v)
{
	v = htole32(v);
	memcpy(p, &v, 4);
}

/* 发一帧并等 want 类型的应答；收到功能错误返回 -2 */
static int transact(const uint8_t *req, int reqlen, uint32_t want,
                    uint8_t *rsp, int rspsize, int timeout_ms)
{
	int guard;

{
	int k;
	printf("  发送(%d):", reqlen);
	for (k = 0; k < reqlen && k < 56; k++)
		printf(" %02x", req[k]);
	puts("");
}
	if (write(fd, req, reqlen) != reqlen) {
		perror("write");
		return -1;
	}

	for (guard = 0; guard < 60; guard++) {
		struct pollfd p = { .fd = fd, .events = POLLIN };
		int n, pr;
		uint32_t type;

		pr = poll(&p, 1, timeout_ms);
		if (pr == 0) {
			fprintf(stderr, "  [超时] 未等到 0x%08x\n", want);
			return -1;
		}
		if (pr < 0) {
			if (errno == EINTR)
				continue;
			perror("poll");
			return -1;
		}

		n = read(fd, rsp, rspsize);
		if (n < 0) {
			if (errno == EAGAIN || errno == EINTR)
				continue;
			perror("read");
			return -1;
		}
		if (n < 12)
			continue;

		{
			int k2;
			printf("  接收(%d):", n);
			for (k2 = 0; k2 < n && k2 < 56; k2++)
				printf(" %02x", rsp[k2]);
			puts("");
		}

		type = rd32(rsp);
		if (type == MBIM_FUNCTION_ERROR) {
			printf("  [功能错误] 错误码 0x%08x\n", n >= 16 ? rd32(rsp + 12) : 0);
			return -2;
		}
		if (type != want) {
			printf("  [跳过] 帧类型 0x%08x（长度 %u）\n", type, rd32(rsp + 4));
			continue;
		}
		return n;
	}

	fprintf(stderr, "  [放弃] 帧太多\n");
	return -1;
}

static int mbim_open(void)
{
	uint8_t req[16], rsp[256];
	int n;

	memset(req, 0, sizeof(req));
	/* 先发一次 CLOSE：ModemManager 被强杀时不会发 CLOSE，模组可能停在
 * 「已打开」状态，此时后续所有命令都会被拒（status 0x9 NOT_REGISTERED）。
 * libmbim 在打开前遇到 unknown state 也是先 CLOSE 再 OPEN。 */
memset(req, 0, sizeof(req));
wr32(req + 0, MBIM_CLOSE_MSG);
wr32(req + 4, 12);
wr32(req + 8, txid++);
transact(req, 12, MBIM_CLOSE_DONE, rsp, sizeof(rsp), 2000);
wr32(req + 0, MBIM_OPEN_MSG);
	wr32(req + 4, 16);
	wr32(req + 8, txid++);
	wr32(req + 12, 4096);

	n = transact(req, 16, MBIM_OPEN_DONE, rsp, sizeof(rsp), 5000);
	if (n < 0) {
		printf("MBIM 打开失败\n");
		return -1;
	}

	printf("MBIM 打开成功（设备报告 MaxControlTransfer=%u）\n\n", rd32(rsp + 12));
	return 0;
}

static void mbim_close(void)
{
	uint8_t req[12], rsp[64];

	memset(req, 0, sizeof(req));
	wr32(req + 0, MBIM_CLOSE_MSG);
	wr32(req + 4, 12);
	wr32(req + 8, txid++);
	transact(req, 12, MBIM_CLOSE_DONE, rsp, sizeof(rsp), 2000);
}

/* 发一条命令：成功返回应答信息区长度（数据在 rsp+CMD_HDR_LEN），-1 传输失败，-2 功能错误 */
static int mbim_command(const uint8_t *uuid, uint32_t cid, uint32_t cmdtype,
                        const uint8_t *info, uint32_t infolen,
                        uint8_t *rsp, int rspsize, uint32_t *status)
{
	uint8_t req[8192];
	uint32_t total;
	char uuidstr[40];
	int n;

	if (CMD_HDR_LEN + (int)infolen > (int)sizeof(req)) {
		fprintf(stderr, "命令过长\n");
		return -1;
	}

	memset(req, 0, CMD_HDR_LEN + infolen);
	total = CMD_HDR_LEN + infolen;
	wr32(req + 0, MBIM_COMMAND_MSG);
	wr32(req + 4, total);
	wr32(req + 8, txid++);
	wr32(req + 12, 1);                  /* FragmentHeader.Total   */
	wr32(req + 16, 0);                  /* FragmentHeader.Current */
	memcpy(req + 20, uuid, 16);         /* ServiceId              */
	wr32(req + 36, cid);                /* CommandId              */
	wr32(req + 40, cmdtype);            /* CommandType            */
	wr32(req + 44, infolen);            /* InformationBufferLength*/
	if (infolen)
		memcpy(req + CMD_HDR_LEN, info, infolen);

	n = transact(req, total, MBIM_COMMAND_DONE, rsp, rspsize, 8000);
	if (n < 0)
		return n;

	uuid_to_str(rsp + 20, uuidstr);
	*status = rd32(rsp + 40);

	if (*status != 0)
		printf("  状态 0x%08x（失败）service=%s cid=%u\n",
		       *status, uuidstr, rd32(rsp + 36));

	return (int)rd32(rsp + 44);
}

/* 先查 CID 1（DEVICE_CAPS）：umbim 就是这么开场的，用它验证会话是否被接受 */
static void probe_caps(void)
{
uint8_t rsp[8192];
uint32_t status = 0;
int len;

puts("DEVICE_CAPS (basic-connect CID 1, QUERY) —— 验证本次会话是否被模组接受");
len = mbim_command(UUID_BASIC_CONNECT, 1, CMD_QUERY, NULL, 0, rsp, sizeof(rsp), &status);
if (len < 0) {
printf("  传输失败（len=%d）", len);
puts("");
return;
}
printf("  status=0x%08x, info=%d 字节  %s", status, len,
       status == 0 ? "→ 会话正常 ✓" : "→ 模组拒绝（会话未被接受）");
puts("");
puts("");
}

/* 查询 CID 9（REGISTER_STATE）：这条依赖注册状态，用来区分 status 9 的语义 */
static void probe_registration(void)
{
	uint8_t rsp[8192];
	uint32_t status = 0;
	int len;

	puts("REGISTER_STATE (basic-connect CID 9, QUERY)");
	len = mbim_command(UUID_BASIC_CONNECT, 9, CMD_QUERY, NULL, 0, rsp, sizeof(rsp), &status);
	printf("  status=0x%08x, info=%d 字节", status, len);
	puts(status == 0 ? "  → 模组已注册（说明 status 9 不是注册问题）" : "  → 未注册/被拒");
	puts("");
}

static int probe_services(void)
{
	uint8_t rsp[16384];
	uint32_t status = 0;
	int len, off, i;
	uint32_t count;

	{
		int attempt;

		/* 模组刚被释放时可能处于瞬态（一律回 status 0x9 NOT_REGISTERED），重试几轮 */
		for (attempt = 0; attempt < 10; attempt++) {
			len = mbim_command(UUID_BASIC_CONNECT, CID_DEVICE_SERVICES, CMD_QUERY,
			                   NULL, 0, rsp, sizeof(rsp), &status);
			if (len >= 4 && status == 0)
				break;
			printf("  第 %d 轮未就绪（len=%d status=0x%08x），10 秒后重试…\n", attempt + 1, len, status);
			sleep(10);
		}
	}
	if (len < 4) {
		printf("DEVICE_SERVICES 查询失败（len=%d status=0x%08x）\n\n", len, status);
		return -1;
	}

	{
		int d;
		printf("  info 前 96 字节:");
		for (d = 0; d < len && d < 1100; d++)
			printf(" %02x", rsp[CMD_HDR_LEN + d]);
		puts("");
	}
	count = rd32(rsp + CMD_HDR_LEN);
	printf("模组声明了 %u 个服务：\n\n", count);

	off = CMD_HDR_LEN + 4;
	for (i = 0; i < (int)count; i++) {
		char uuidstr[40];
		uint32_t cids, j;

		if (off + 20 > CMD_HDR_LEN + len)
			break;

		uuid_to_str(rsp + off, uuidstr);
		cids = rd32(rsp + off + 16);
		printf("  [%d] %s\n      %s\n      CID(%u):", i, uuidstr, svc_name(uuidstr), cids);
		for (j = 0; j < cids && off + 20 + (int)(j + 1) * 4 <= CMD_HDR_LEN + len; j++)
			printf(" %u", rd32(rsp + off + 20 + j * 4));
		printf("\n");
		off += 20 + cids * 4;
	}
	printf("\n");
	return 0;
}

static void print_at_response(const uint8_t *p, int len)
{
	int i;

	if (len <= 4) {
		printf("  （应答信息区为空，len=%d）\n", len);
		return;
	}

	printf("  文本应答: 「");
	for (i = 4; i < len; i++) {
		unsigned char c = p[i];
		putchar((c >= 32 && c < 127) || c == '\n' || c == '\r' ? c : '.');
	}
	printf("」\n  原始字节:");
	for (i = 0; i < len && i < 48; i++)
		printf(" %02x", p[i]);
	printf("\n");
}

static void try_qdu_at(const char *at)
{
	uint8_t info[512], rsp[8192];
	uint32_t status = 0;
	int len, atlen = strlen(at);

	memset(info, 0, sizeof(info));
	memcpy(info + 4, at, atlen);

	printf("QDU CID 8 (SET) 发送 AT 指令: '%s'\n", at);
	len = mbim_command(UUID_QDU, CID_QDU_AT_COMMAND, CMD_SET,
	                   info, 4 + atlen, rsp, sizeof(rsp), &status);
	if (len == -2) {
		printf("  → 模组以功能错误拒绝：它没有 QDU 服务/CID（不是命令格式问题）\n\n");
		return;
	}
	if (len < 0) {
		printf("  传输失败\n\n");
		return;
	}
	if (status != 0) {
		printf("  模组拒绝（status=0x%08x）→ 不支持 QDU AT 通道\n\n", status);
		return;
	}

	printf("  ✓ 成功，这就是可用的 MBIM-AT 通道\n");
	print_at_response(rsp + CMD_HDR_LEN, len);
	printf("\n");
}

static void try_atds_location(void)
{
	uint8_t rsp[8192];
	uint32_t status = 0;
	int len, i;

	printf("ATDS CID 2 (QUERY) 小区位置\n");
	len = mbim_command(UUID_ATDS, CID_ATDS_LOCATION, CMD_QUERY,
	                   NULL, 0, rsp, sizeof(rsp), &status);
	if (len == -2) {
		printf("  → 功能错误：模组未声明 ATDS\n\n");
		return;
	}
	if (len < 0) {
		printf("  传输失败\n\n");
		return;
	}
	if (status != 0) {
		printf("  模组拒绝（status=0x%08x）→ 不支持 ATDS 位置\n\n", status);
		return;
	}

	printf("  ✓ 返回 %d 字节:", len);
	for (i = 0; i < len && i < 40; i++)
		printf(" %02x", rsp[CMD_HDR_LEN + i]);
	printf("\n\n");
}

int main(int argc, char **argv)
{
	const char *dev = argc > 1 ? argv[1] : "/dev/cdc-wdm0";

	setvbuf(stdout, NULL, _IOLBF, 0);

	fd = open(dev, O_RDWR | O_NONBLOCK);
	if (fd < 0) {
		fprintf(stderr, "打不开 %s: %s\n（ModemManager 及其 mbim-proxy 是否仍在运行？）\n",
		        dev, strerror(errno));
		return 1;
	}

	printf("=== MBIM 探测：%s ===\n\n", dev);

	if (mbim_open() < 0) {
		close(fd);
		return 1;
	}

	probe_caps();
	probe_registration();

	probe_services();

	printf("--- 通道 1：QDU CID 8（移远 QMbimAT 的 AT over MBIM）---\n");
	try_qdu_at("ATI");
	try_qdu_at("AT+QENG=\"servingcell\"");

	printf("--- 通道 2：ATDS CID 2（ModemManager 原生小区位置）---\n");
	try_atds_location();

	mbim_close();
	close(fd);

	printf("探测结束。\n");
	return 0;
}
