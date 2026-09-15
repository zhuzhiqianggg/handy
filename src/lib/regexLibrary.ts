/**
 * 正则表达式知识库（数据 + 纯函数，无框架依赖）。
 *
 * # 为什么需要它
 *
 * 用户反馈（#6）：
 *   「正则表达式等工具都可以优化加强，多给一些实例正则，带测试示例文本方便测试的……
 *     正则表达式也包含常用的各种表达式，选择某一个下面填充对应的表达式文本，
 *     当然文本不是简单的文本能展示出正则的各种复杂场景的。」
 *
 * 三个要点落在这里：
 *   1. [`REGEX_LIBRARY`]：**带说明、带真实场景**的正则库（不是光秃秃一条 pattern），
 *      标注分组、坑点、配套示例文本，部分还带「断言用例」（这条正则该命中什么、
 *      该不命中什么）—— 这才是「复杂场景」能被验证的方式；
 *   2. [`SAMPLE_TEXTS`]：**多行真实样本**（Nginx 日志、Java 堆栈、slow log、K8s YAML、
 *      脏数据……），一键填进测试框，而不是让用户自己编一段「name@example.com」；
 *   3. [`explainPattern`]：把 pattern 逐 token 翻译成人话 —— 正则工具最大的门槛
 *      不是「能不能测」，而是「这条正则凭什么是这个意思」。
 */

// ————————————————————————————————————————————————————————————————
// 类型
// ————————————————————————————————————————————————————————————————

/** 断言用例：验证「这条正则在该命中 / 不该命中的地方，确实如此」 */
export interface RegexCase {
  /** 被检验的短文本 */
  input: string;
  /** 期望是否命中（用于显示 ✅ / ❌） */
  expect: boolean;
  /** 为什么 */
  note: string;
}

/** 正则库条目 */
export interface RegexExample {
  /** 分类 */
  group: string;
  /** 名称 */
  label: string;
  /** 表达式（不含定界符） */
  pattern: string;
  /** 建议 flags */
  flags: string;
  /** 用途 / 坑点说明 */
  description: string;
  /** 配套测试文本（点「连示例文本一起填」时使用；缺省则用通用混合样本） */
  text?: string;
  /** 断言用例（可选；用于「复杂场景」自证） */
  cases?: readonly RegexCase[];
}

/** 示例测试文本 */
export interface RegexSample {
  group: string;
  label: string;
  note: string;
  text: string;
}

// ————————————————————————————————————————————————————————————————
// 示例测试文本（多行、真实）
// ————————————————————————————————————————————————————————————————

const NGINX_LOG = `10.20.30.41 - - [15/Sep/2026:21:04:11 +0800] "GET /api/v1/orders?page=2&size=50 HTTP/1.1" 200 18432 "https://ops.example.com/dashboard" "Mozilla/5.0 (Windows NT 10.0; Win64; x64)"
10.20.30.55 - - [15/Sep/2026:21:04:12 +0800] "POST /api/v1/login HTTP/1.1" 401 312 "-" "curl/8.4.0"
10.20.30.41 - - [15/Sep/2026:21:04:13 +0800] "GET /static/app.7f3c21.js HTTP/1.1" 200 921123 "-" "Mozilla/5.0"
172.16.8.9 - svc_doris [15/Sep/2026:21:05:01 +0800] "PUT /api/v1/resource/8821 HTTP/1.1" 500 1024 "-" "python-requests/2.31"
10.20.30.77 - - [15/Sep/2026:21:05:44 +0800] "DELETE /api/v1/endpoint/12 HTTP/1.1" 204 0 "-" "PostmanRuntime/7.36"
::1 - - [15/Sep/2026:21:06:02 +0800] "GET /healthz HTTP/1.1" 200 2 "-" "kube-probe/1.29"`;

const APP_LOG = `2026-09-15 21:03:58,112 INFO  c.o.resource.DbPool - 初始化连接池 mysql://10.20.30.204:3306/ops_db max=20
2026-09-15 21:04:01,447 WARN  c.o.resource.DorisClient - Doris FE 响应偏慢 cost=2381ms host=10.20.30.206:8030
2026-09-15 21:04:02,889 ERROR c.o.resource.NebulaRepo - 查询超时 space=ops_graph timeout=3000ms
java.util.concurrent.TimeoutException: Query timed out after 3000 ms
	at com.vesoft.nebula.client.graph.GraphSession.execute(GraphSession.java:214)
	at com.ops.resource.NebulaRepo.query(NebulaRepo.java:88)
2026-09-15 21:04:03,120 INFO  c.o.resource.Pool - 连接池健康检查 done cost=12ms
2026-09-15 21:05:19,004 ERROR c.o.api.GlobalHandler - 未捕获异常 uri=/api/v1/resource/8821
com.ops.common.BizException: 资源 8821 状态非法：RUNNING -> DELETED
	at com.ops.resource.ResourceService.transition(ResourceService.java:301)
2026-09-15 21:06:00,001 INFO  c.o.schedule.CronRunner - 触发任务 resource-sync，下次 21:16:00`;

const SLOW_LOG = `# Time: 2026-09-15T21:01:04.883921+08:00
# User@Host: ops_app[ops_app] @ [10.20.30.55]  Id: 88213
# Query_time: 12.840311  Lock_time: 0.000188 Rows_sent: 1  Rows_examined: 2843113
SET timestamp=1789567864;
SELECT r.id, r.name, COUNT(*) FROM database_resource r JOIN resource_tag t ON t.resource_id = r.id GROUP BY r.id, r.name;
# Time: 2026-09-15T21:02:31.221004+08:00
# User@Host: ops_app[ops_app] @ [10.20.30.204]  Id: 88240
# Query_time: 8.117644  Lock_time: 0.000092 Rows_sent: 42  Rows_examined: 910233
SET timestamp=1789567951;
SELECT * FROM database_endpoint WHERE env = 'prod' ORDER BY updated_at DESC LIMIT 100;`;

const SYSLOG = `Sep 15 21:00:01 local-test-ops systemd[1]: Started Daily apt download activities.
Sep 15 21:00:12 local-test-ops kernel: [41258.882113] TCP: request_sock_TCP: Possible SYN flooding on port 8100. Sending cookies.
Sep 15 21:01:33 local-test-ops sshd[28841]: Failed password for invalid user admin from 203.0.113.77 port 51512 ssh2
Sep 15 21:01:35 local-test-ops sshd[28841]: pam_unix(sshd:auth): authentication failure; logname= uid=0 euid=0 tty=ssh ruser= rhost=203.0.113.77
Sep 15 21:02:58 local-test-ops dockerd[1420]: time="2026-09-15T21:02:58.441Z" level=warning msg="container mysql-5.7 health check failing" id=8f2c1a9b4d0e
Sep 15 21:04:07 local-test-ops systemd[1]: ops-agent.service: Main process exited, code=exited, status=137/n/a`;

const K8S_YAML = `apiVersion: apps/v1
kind: StatefulSet
metadata:
  name: nebula-graphd
  namespace: ops-graph
  labels:
    app: nebula
    tier: graph
spec:
  replicas: 3
  serviceName: nebula-graphd-headless
  template:
    spec:
      containers:
        - name: graphd
          image: vesoft/nebula-graphd:v3.8.0
          resources:
            limits:
              cpu: "4"
              memory: 8Gi
          env:
            - name: TZ
              value: "Asia/Shanghai"
          ports:
            - containerPort: 9669
            - containerPort: 19669`;

const MIXED_DIRTY = `联系 张伟 电话 13812345678 备用 0571-88886666
邮箱 zhangsan@example.com、li.si+ops@sub.example.co 都是 10.20.30.44 网段下的
时间窗口 2026-09-15 到 2026-09-30，其中 2026-13-45 是伪造的日期
URL 分别是 https://console.example.com:8443/ops?tab=database#detail 和 http://10.20.30.204:49200/metrics
这里的   空格   很多，行尾还有三个空格   
重复重复 的 词词 要 要 被 抓 出来
中文标点：你好，世界！（测试）【重点】「引用」
大小写混排 MixedCaseValue 与 camelCaseField、snake_case_col
金额 ¥12,345.67 与 $99.9 与 1,234,567.89
mac 地址 3C:52:82:1A:0F:9B，ipv6 fe80::1c2d:3f4a:5b6c:7d8e
版本号 v1.29.3-rc.2 与 2.0.0`;

const JSON_DATA = `{
  "code": 0,
  "message": "ok",
  "data": {
    "id": 8821,
    "name": "ops-resource-manage-system",
    "endpoints": [
      { "type": "mysql", "host": "10.20.30.204", "port": 3306, "env": "prod", "enabled": true },
      { "type": "redis", "host": "10.20.30.205", "port": 6379, "env": "prod", "enabled": true },
      { "type": "doris", "host": "10.20.30.206", "port": 9030, "env": "test", "enabled": false }
    ],
    "tags": ["\\u8fd0\\u7ef4", "database"],
    "updatedAt": "2026-09-15T21:04:11+08:00"
  }
}`;

const MD_DOC = `# 资源平台改造记录

## 一、背景
现有 **8 类**数据库的管理入口分散在控制台各处，日常要先点 3 层才能到。

## 二、方案
1. 统一 endpoint 列表页
2. 资源详情左侧按技术栈分组
3. 支持批量导入 CSV

### 待办
- [x] DatabaseEndpoint 模型
- [ ] 迁移脚本
- [ ] 权限校验

> 注意：\`env=prod\` 的变更必须走审批。

\`\`\`shell
kubectl -n ops-graph get pods -o wide
\`\`\``;

const SHELL_SCRIPT = `#!/usr/bin/env bash
set -euo pipefail

# 创建 graphd 与 storaged cgroup 并设置内存限制
GROUP_PATH="/sys/fs/cgroup/graphd"
MEMORY_LIMIT=$((8 * 1024 * 1024 * 1024))

if [[ ! -d "$GROUP_PATH" ]]; then
  mkdir -p "$GROUP_PATH" || { echo "Error: creating cgroup directory failed"; exit 1; }
fi

echo "$MEMORY_LIMIT" > "$GROUP_PATH/memory.max"
if [[ $? -ne 0 ]]; then
  echo "Error: setting memory limit for cgroup failed" >&2
  exit 1
fi

NEBULA_GRAPH_PID=$(pgrep -f /opt/nebula-graph/bin/nebula-graphd || true)
if [[ -z "$NEBULA_GRAPH_PID" ]]; then
  echo "Error: nebula-graphd process not found" >&2
  exit 1
fi
echo "graphd pid=$NEBULA_GRAPH_PID"`;

export const SAMPLE_TEXTS: readonly RegexSample[] = [
  { group: '运维日志', label: 'Nginx access log', note: '含 IPv6、状态码、耗时字段', text: NGINX_LOG },
  { group: '运维日志', label: '应用日志 + 异常堆栈', note: '带级别、时间戳、Java 堆栈', text: APP_LOG },
  { group: '运维日志', label: 'MySQL 慢查询日志', note: 'Query_time / Rows_examined', text: SLOW_LOG },
  { group: '运维日志', label: 'Linux syslog', note: 'systemd / sshd / 内核告警', text: SYSLOG },
  { group: '配置', label: 'K8s StatefulSet YAML', note: '缩进、引号、多级嵌套', text: K8S_YAML },
  { group: '配置', label: 'JSON 响应体', note: '含转义字符与嵌套数组', text: JSON_DATA },
  { group: '文本', label: '脏数据混合样本', note: '电话/邮箱/URL/日期/重复词/全角标点', text: MIXED_DIRTY },
  { group: '文本', label: 'Markdown 文档', note: '标题/列表/引用/代码块', text: MD_DOC },
  { group: '文本', label: 'Shell 脚本', note: '变量、判断、管道、重定向', text: SHELL_SCRIPT },
];

/** 默认填充的混合样本（正则没配示例文本时用它） */
export const DEFAULT_SAMPLE_TEXT = MIXED_DIRTY;

// ————————————————————————————————————————————————————————————————
// 正则库
// ————————————————————————————————————————————————————————————————

export const REGEX_LIBRARY: readonly RegexExample[] = [
  // —— 常见校验 ——
  {
    group: '常见校验',
    label: '中国大陆手机号',
    pattern: '^1[3-9]\\d{9}$',
    flags: '',
    description: '1 开头 + 第二位 3-9 + 9 位数字，共 11 位。加了 ^ $ 才算「整串校验」，否则 139123456789 里的一段也会命中。',
    cases: [
      { input: '13812345678', expect: true, note: '正常号码' },
      { input: '12812345678', expect: false, note: '第二位 2 不合法' },
      { input: '1381234567', expect: false, note: '只有 10 位' },
    ],
  },
  {
    group: '常见校验',
    label: '邮箱（宽松）',
    pattern: '^[\\w.%+-]+@[\\w.-]+\\.[A-Za-z]{2,}$',
    flags: '',
    description: '日常够用。真正的 RFC 5322 邮箱正则有两千多字符，工程上不值得——真要严校验就发确认邮件。',
  },
  {
    group: '常见校验',
    label: 'IPv4（严格 0-255）',
    pattern: '^(?:(?:25[0-5]|2[0-4]\\d|1\\d{2}|[1-9]?\\d)\\.){3}(?:25[0-5]|2[0-4]\\d|1\\d{2}|[1-9]?\\d)$',
    flags: '',
    description: '每一段都限定了 0-255，所以 999.1.1.1 不会误判。相比 `\\d{1,3}(\\.\\d{1,3}){3}` 才是可用的写法。',
    cases: [
      { input: '10.20.30.204', expect: true, note: '内网地址' },
      { input: '256.1.1.1', expect: false, note: '第一段超 255' },
      { input: '1.1.1', expect: false, note: '只有 3 段' },
    ],
  },
  {
    group: '常见校验',
    label: '强密码（8-20 位三种字符）',
    pattern: '^(?=.*[a-z])(?=.*[A-Z])(?=.*\\d)[A-Za-z\\d!@#$%^&*]{8,20}$',
    flags: '',
    description: '三个前瞻（lookahead）分别断言「至少一个小写 / 一个大写 / 一个数字」，最后才是整体长度与字符集。前瞻只判断不消耗，所以能叠加多个条件。',
  },
  {
    group: '常见校验',
    label: '日期 YYYY-MM-DD（含闰年）',
    pattern: '^(?:(?:19|20)\\d{2}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\\d|30)|02-(?:0[1-9]|1\\d|2[0-8]))|(?:19|20)(?:[02468][048]|[13579][26])-02-29)$',
    flags: '',
    description: '按月份区分天数：大月 31 天、小月 30 天、2 月 28 天，最后单独放行闰年 2-29。这是「正则能表达复杂业务规则」的典型样本。',
    cases: [
      { input: '2026-09-15', expect: true, note: '普通日期' },
      { input: '2026-02-29', expect: false, note: '2026 不是闰年' },
      { input: '2024-02-29', expect: true, note: '2024 是闰年' },
      { input: '2026-13-01', expect: false, note: '没有 13 月' },
    ],
  },
  {
    group: '常见校验',
    label: '端口号 1-65535',
    pattern: '^(?:[1-9]\\d{0,3}|[1-5]\\d{4}|6[0-4]\\d{3}|65[0-4]\\d{2}|655[0-2]\\d|6553[0-5])$',
    flags: '',
    description: '按位分段穷举区间，比 `\\d{1,5}` 准得多。填防火墙 / 白名单时很有用。',
    cases: [
      { input: '65535', expect: true, note: '上界' },
      { input: '65536', expect: false, note: '越界' },
      { input: '08080', expect: false, note: '前导 0 不合法' },
    ],
  },
  {
    group: '常见校验',
    label: '金额（最多两位小数）',
    pattern: '^\\d+(?:\\.\\d{1,2})?$',
    flags: '',
    description: '注意别写成 `^\\d+\\.\\d{2}$`——那样整数金额会被判为非法。',
  },

  // —— 网络与运维 ——
  {
    group: '网络与运维',
    label: 'Nginx access log 拆字段',
    pattern: '^(?<ip>\\S+) \\S+ \\S+ \\[(?<time>[^\\]]+)\\] "(?<method>[A-Z]+) (?<path>[^ ]*) [^"]*" (?<status>\\d{3}) (?<size>\\d+|-)',
    flags: 'gm',
    description: '命名捕获组一把拆出 IP / 时间 / 方法 / 路径 / 状态码 / 响应大小。配合 g 标志可逐行提取，是日志聚合最实用的写法。',
    text: NGINX_LOG,
  },
  {
    group: '网络与运维',
    label: '日志行（时间 + 级别 + logger）',
    pattern: '^(?<date>\\d{4}-\\d{2}-\\d{2})[ T](?<time>\\d{2}:\\d{2}:\\d{2})[.,]\\d+\\s+(?<level>DEBUG|INFO|WARN|ERROR|FATAL)\\s+(?<logger>[\\w.]+)',
    flags: 'gm',
    description: '标准 Spring / Log4j2 行格式。`[.,]` 同时兼容「秒,毫秒」与「秒.毫秒」两种写法。',
    text: APP_LOG,
  },
  {
    group: '网络与运维',
    label: 'URL 全量拆解',
    pattern: '^(?<proto>https?)://(?<host>[^/:?#]+)(?::(?<port>\\d+))?(?<path>[^?#]*)(?:\\?(?<query>[^#]*))?(?:#(?<hash>.*))?$',
    flags: '',
    description: '协议 / 主机 / 端口 / 路径 / 查询串 / 锚点分别成组，缺省部分全部可选。测试时用多行样本才看得出效果。',
    cases: [
      { input: 'https://console.example.com:8443/ops?tab=db#detail', expect: true, note: '全字段' },
      { input: 'http://10.20.30.204/metrics', expect: true, note: '无端口无查询串' },
    ],
  },
  {
    group: '网络与运维',
    label: '从慢日志抓耗时',
    pattern: 'Query_time:\\s*(?<sec>\\d+\\.\\d+)',
    flags: 'g',
    description: '提取 MySQL slow log 的 Query_time，配合替换可一键算出总耗时（把 `$<sec>` 换成别的）。',
    text: SLOW_LOG,
  },
  {
    group: '网络与运维',
    label: 'IP:端口 批量提取',
    pattern: '(?<ip>\\d{1,3}(?:\\.\\d{1,3}){3}):(?<port>\\d{1,5})',
    flags: 'g',
    description: '不加 ^ $，用于「从一堆文本里捞出所有 ip:port」。注意这是宽松匹配，真要校验合法性请用上面的严格 IPv4。',
    text: SYSLOG,
  },
  {
    group: '网络与运维',
    label: 'MAC 地址',
    pattern: '^([0-9A-Fa-f]{2}[:-]){5}[0-9A-Fa-f]{2}$',
    flags: '',
    description: '兼容 `3C:52:82:1A:0F:9B` 与 `3C-52-82-1A-0F-9B` 两种分隔符。',
  },
  {
    group: '网络与运维',
    label: 'SemVer 版本号',
    pattern: '^v?\\d+\\.\\d+\\.\\d+(?:-[\\w.]+)?$',
    flags: '',
    description: '匹配 `1.29.3`、`v3.8.0`、`2.0.0-rc.2`。`(?:...)` 是非捕获组——不需要引用的分组就别捕获，省内存也避免编号错位。',
    cases: [
      { input: 'v3.8.0', expect: true, note: '带 v 前缀' },
      { input: '1.29.3-rc.2', expect: true, note: '预发布标识' },
      { input: '1.2', expect: false, note: '缺少 patch 段' },
    ],
  },

  // —— 日志分析 ——
  {
    group: '日志分析',
    label: 'Java 异常首行',
    pattern: '^(?<exc>[\\w.]+(?:Exception|Error)): (?<msg>.*)$',
    flags: 'gm',
    description: '只抓「类名: 消息」那一行，堆栈帧自动忽略。做告警聚合时用它把上千条异常归并成几十类。',
    text: APP_LOG,
  },
  {
    group: '日志分析',
    label: 'Docker 容器 ID（短/长）',
    pattern: '\\b[0-9a-f]{12,64}\\b',
    flags: 'g',
    description: '`{12,64}` 一个量词覆盖短 ID 与完整 ID。`\\b` 边界防止把长十六进制串从中间切开。',
  },
  {
    group: '日志分析',
    label: '内核 / sshd 告警行',
    pattern: '^\\w{3}\\s+\\d{1,2} \\d{2}:\\d{2}:\\d{2} \\S+ (?<unit>[\\w.-]+)(?:\\[\\d+\\])?: (?<msg>.*)$',
    flags: 'gm',
    description: 'syslog 格式：`Sep 15 21:00:01 host unit[pid]: msg`。抓爆破登录、OOM、SYN flooding 都靠它先切出行。',
    text: SYSLOG,
  },

  // —— 文本处理 ——
  {
    group: '文本处理',
    label: '手机号 + 邮箱 一并捞',
    pattern: '1[3-9]\\d{9}|[\\w.%+-]+@[\\w.-]+\\.[A-Za-z]{2,}',
    flags: 'g',
    description: '`|` 的优先级最低，两条规则并列即可。常用于敏感信息扫描 / 脱敏前定位。',
    text: MIXED_DIRTY,
  },
  {
    group: '文本处理',
    label: '重复词检测',
    pattern: '\\b(\\w+)\\s+\\1\\b',
    flags: 'gi',
    description: '`\\1` 反向引用第 1 个捕获组，专治「的 的」「the the」。注意英文单词才有 \\b 边界，中文需改用 `(\\S{1,3})\\s*\\1`。',
  },
  {
    group: '文本处理',
    label: '行尾空白（清理用）',
    pattern: '[ \\t]+$',
    flags: 'gm',
    description: '配合替换为空串，一键清掉全文件行尾空格。提交代码前最常用的一步。',
    text: MIXED_DIRTY,
  },
  {
    group: '文本处理',
    label: '驼峰转下划线',
    pattern: '([a-z0-9])([A-Z])',
    flags: 'g',
    description: '替换为 `$1_$2` 即得 snake_case。用替换面板试一下：`camelCaseField` → `camel_Case_Field`（多轮或加 g 可一次到位）。',
    cases: [{ input: 'camelCaseField', expect: true, note: '两处驼峰边界都会命中' }],
  },
  {
    group: '文本处理',
    label: '数字千分位',
    pattern: '\\B(?=(\\d{3})+(?!\\d))',
    flags: 'g',
    description: '零宽断言经典用法：`\\B` 保证不在词首，`(?=(\\d{3})+(?!\\d))` 断言「右侧恰好是 3 的整数倍个数字」。替换成 `,` 即可格式化。',
    text: MIXED_DIRTY,
  },
  {
    group: '文本处理',
    label: '中文标点 / 全角字符',
    pattern: '[\\u3000-\\u303F\\uFF00-\\uFFEF]',
    flags: 'g',
    description: '排查「接口报错但看不出为什么」的元凶：全角逗号、全角空格、全角小括号。',
    text: MIXED_DIRTY,
  },
  {
    group: '文本处理',
    label: '剥离 HTML 标签',
    pattern: '</?[a-zA-Z][^>]*>',
    flags: 'g',
    description: '粗糙但实用。注意不要用正则去「解析」HTML——真要解析请上 DOM 解析器，正则只适合清洗。',
  },
  {
    group: '文本处理',
    label: 'JSON 的 key',
    pattern: '"(?<key>[^"\\\\]*(?:\\\\.[^"\\\\]*)*)"\\s*:',
    flags: 'g',
    description: '`[^"\\\\]*(?:\\\\.[^"\\\\]*)*` 是「匹配带转义的字符串字面量」的标准写法——比 `".*?"` 健壮，能正确处理 `"a\\"b": 1` 这类内容。',
    text: JSON_DATA,
  },
  {
    group: '文本处理',
    label: 'Markdown 标题层级',
    pattern: '^(?<hashes>#{1,6})\\s+(?<title>.+)$',
    flags: 'gm',
    description: '`(?<hashes>` 组长度就是层级。生成目录、批量改级别都用它。',
    text: MD_DOC,
  },
  {
    group: '文本处理',
    label: 'Unicode 汉字（\\p{Script=Han}）',
    pattern: '^\\p{Script=Han}{2,4}$',
    flags: 'u',
    description: '必须带 `u` 标志才支持 `\\p{...}`。比 `[\\u4e00-\\u9fa5]` 覆盖更全（含扩展区汉字）。',
    cases: [
      { input: '张伟', expect: true, note: '两字姓名' },
      { input: '张伟A', expect: false, note: '混入拉丁字母' },
    ],
  },

  // —— 进阶与陷阱 ——
  {
    group: '进阶与陷阱',
    label: '跳过注释行',
    pattern: '^(?!\\s*(?://|#)).+$',
    flags: 'gm',
    description: '负向前瞻 `(?!...)`：行首位置向右看，若不是注释符号才继续。用来过滤配置文件里的注释行。',
    text: SHELL_SCRIPT,
  },
  {
    group: '进阶与陷阱',
    label: '⚠ 灾难性回溯（反面教材）',
    pattern: '^(a+)+$',
    flags: '',
    description: '别在生产用：嵌套量词会让失败输入的回溯次数指数级暴涨（20 个 a 加一个 b 就能卡住线程）。正确写法是 `^a+$`。列在这里是为了让你认得它。',
    cases: [
      { input: 'aaaa', expect: true, note: '能命中' },
      { input: 'aaaab', expect: false, note: '输入越长，耗时越离谱 —— 这就是 ReDoS' },
    ],
  },
  {
    group: '进阶与陷阱',
    label: '正向环视取上下文',
    pattern: '\\$(?=\\d)',
    flags: 'g',
    description: '`(?=...)` 只断言不消耗：匹配「后面跟数字的美元符」，但不会把数字吃进结果里，适合做插入式替换。',
  },
];

/** 分组顺序（界面按此渲染） */
export const REGEX_GROUPS: readonly string[] = [
  '常见校验',
  '网络与运维',
  '日志分析',
  '文本处理',
  '进阶与陷阱',
];

// ————————————————————————————————————————————————————————————————
// 语法解释（把 pattern 拆成 token 讲人话）
// ————————————————————————————————————————————————————————————————

/** 一个语法片段的解释 */
export interface ExplainToken {
  /** 原始片段 */
  raw: string;
  /** 中文解释 */
  text: string;
  /** 是否是可读的字面量（用于弱化显示） */
  literal: boolean;
}

/** 预置元字符释义（键为片段字面量） */
const META: Record<string, string> = {
  '\\d': '一个数字（0-9）',
  '\\D': '一个非数字字符',
  '\\w': '一个单词字符（字母 / 数字 / 下划线）',
  '\\W': '一个非单词字符',
  '\\s': '一个空白字符（空格 / Tab / 换行）',
  '\\S': '一个非空白字符',
  '\\b': '单词边界（零宽，不消耗字符）',
  '\\B': '非单词边界（零宽）',
  '\\n': '换行符',
  '\\t': '制表符',
  '.': '任意字符（默认不含换行；加 s 标志后含换行）',
  '^': '行 / 串的开头（多行模式下是每行开头）',
  '$': '行 / 串的结尾',
  '*': '前面的元素重复 0 次或多次',
  '+': '前面的元素重复 1 次或多次',
  '?': '前面的元素出现 0 或 1 次（或使量词变为非贪婪）',
  '|': '或：左右任选其一',
  '(': '开始一个捕获组（可用 $1 引用）',
  '(?:': '开始一个非捕获组（只分组，不占编号）',
  '(?=': '正向前瞻：右侧必须匹配，但不消耗',
  '(?!': '负向前瞻：右侧必须**不**匹配',
  '(?<=': '正向后顾：左侧必须匹配（部分环境不支持）',
  '(?<!': '负向后顾：左侧必须**不**匹配',
  ')': '分组结束',
  '[': '字符类开始',
  ']': '字符类结束',
  '{': '量词开始：{n} / {n,} / {n,m}',
  '}': '量词结束',
  '\\': '转义：让下一个字符变成字面量',
};

/**
 * 把正则拆成可读片段。
 *
 * 实现刻意保持「够用就好」：按字符扫描，优先识别 `\x` 转义、`[...]` 字符类、
 * `(...)` 分组前缀、`{n,m}` 量词；其余按字面量归并。不去做完整的正则语法树——
 * 目标是让用户看懂，不是编译。
 */
export function explainPattern(pattern: string): ExplainToken[] {
  const tokens: ExplainToken[] = [];
  let literal = '';
  const flushLiteral = (): void => {
    if (literal.length > 0) {
      tokens.push({ raw: literal, text: '字面量（原样匹配这些字符）', literal: true });
      literal = '';
    }
  };

  let i = 0;
  while (i < pattern.length) {
    const ch = pattern[i] ?? '';

    // 字符类整体作为一个片段
    if (ch === '[') {
      flushLiteral();
      const end = pattern.indexOf(']', i + 1);
      const raw = end > 0 ? pattern.slice(i, end + 1) : pattern.slice(i);
      const negated = raw.startsWith('[^');
      tokens.push({
        raw,
        text: negated
          ? '字符类（取反）：匹配**不在**该集合里的任意一个字符'
          : '字符类：匹配集合里的任意一个字符（范围用 `-`，如 0-9）',
        literal: false,
      });
      i += raw.length;
      continue;
    }

    // 分组：识别 (?: (?= (?! (?<= (?<! (?<name>
    if (ch === '(') {
      const named = /^\(\?<([A-Za-z_$][\w$]*)>/.exec(pattern.slice(i));
      const head = named
        ? named[0]
        : (['(?:', '(?=', '(?!', '(?<=', '(?<!'].find((prefix) => pattern.startsWith(prefix, i)) ?? '(');
      flushLiteral();
      tokens.push({
        raw: head,
        text: named
          ? `命名捕获组：抓到的内容可用 $<${named[1]}> 引用`
          : (META[head] ?? '开始一个分组'),
        literal: false,
      });
      i += head.length;
      continue;
    }

    // 量词
    if (ch === '{') {
      const end = pattern.indexOf('}', i + 1);
      if (end > i) {
        flushLiteral();
        const raw = pattern.slice(i, end + 1);
        tokens.push({ raw, text: '量词：指定前面元素的重复次数', literal: false });
        i = end + 1;
        continue;
      }
    }

    // 转义序列
    if (ch === '\\' && i + 1 < pattern.length) {
      const next = pattern[i + 1] ?? '';
      const pair = `\\${next}`;
      flushLiteral();
      const unicode = /^\\u\{?[0-9a-fA-F]+\}?/.exec(pattern.slice(i));
      const pClass = /^\\[pP]\{[^}]+\}/.exec(pattern.slice(i));
      const quant = /^\\[dDwWsSbB]/.exec(pattern.slice(i));
      if (pClass) {
        tokens.push({ raw: pClass[0], text: 'Unicode 属性：按字符类别匹配（需 u 标志）', literal: false });
        i += pClass[0].length;
        continue;
      }
      if (unicode) {
        tokens.push({ raw: unicode[0], text: 'Unicode 码点字面量', literal: false });
        i += unicode[0].length;
        continue;
      }
      if (quant) {
        tokens.push({ raw: quant[0], text: META[quant[0]] ?? '转义序列', literal: false });
        i += quant[0].length;
        continue;
      }
      tokens.push({ raw: pair, text: `转义：匹配字面量「${next}」本身`, literal: false });
      i += 2;
      continue;
    }

    if (META[ch] !== undefined) {
      flushLiteral();
      tokens.push({ raw: ch, text: META[ch], literal: false });
      i += 1;
      continue;
    }

    literal += ch;
    i += 1;
  }
  flushLiteral();
  return tokens;
}
