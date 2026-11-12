# @local/dsh-easyeda

让 DSH 通过**嘉立创EDA专业版 / EasyEDA Pro V4 的命令行客户端**操作 EDA：快速分析原理图、迅速定位元器件、绘制并检查 PCB。

- 客户端实测版本：**JLCEDA Pro 4.1.99**（CLI 需要 v4.1.70+）
- 可执行文件：`D:\APP\lceda-pro\lceda-pro.exe`（国际版为 `easyeda-pro`）
- 工作方式：DSH 插件 → 调用 `lceda-pro` CLI → 通过本地 bridge 与正在运行的编辑器通信

## 工具

| 工具 | 作用 |
|---|---|
| `eda_status` | 检查 bridge 连通性、客户端版本、已打开的编辑器会话；可打开/关闭工程 |
| `eda_schematic` | 一次调用分析整个原理图：器件（型号/值/封装/立创编号）、网络数、引脚连接、异常（单引脚网络、悬空引脚、缺封装、重复位号） |
| `eda_locate` | 按位号或关键词定位元器件：返回图页、坐标、旋转、引脚-网络表，并默认打开图页、选中、缩放 |
| `eda_sch_edit` | 改原理图：改值/封装/位号、移动旋转、删除、换器件、从库里放新器件、画导线、加网络标签 |
| `eda_sch_net` | 改网络：把某个引脚改到指定网络（`{designator, pin, net}`），或先 `inspect` 看这个引脚的网到底挂在哪根线上；`netflag` 放电源/地符号并校验落点 |
| `eda_sch_module` | 原理图分块：框住一组器件、在下方写上模块名；之后按模块名一键选中并缩放到该块 |
| `eda_pcb` | PCB 概览：器件布局（层/旋转/坐标）、网络/走线/过孔数、板框段数、坐标范围、原理图中未放置的器件、可选 DRC |
| `eda_pcb_draw` | 在 PCB 上画铜线/折线/过孔/**板框**；一批操作 = 一个可撤销组，失败默认整组回滚；支持 `importChanges` 与 `dryRun` |
| `eda_pcb_layout` | 摆放/移动器件（`place`），以及自动布局 `auto_layout`、自动布线 `auto_route`（作业模型，`job_status` 续查） |
| `eda_export` | 导出 BOM / 网表（原理图侧）、Gerber / 坐标文件 / PDF（PCB 侧），并校验文件确实落盘 |
| `eda_run` | 逃生舱：直接在该会话里执行 `eda.*` JavaScript |
| `eda_reference` | 查询随客户端安装的 API 参考（类 / 方法 / 设计文件格式），避免凭记忆写签名 |

## 典型流程

```
eda_status                                  # 客户端在跑吗？有没有会话？
eda_schematic {"nets": true}                # 全工程摸一遍，看异常
eda_locate   {"designator": "U1"}           # 跳到 U1，编辑器里直接选中放大
eda_pcb      {"drc": true}                  # PCB 现状 + DRC
eda_pcb_draw {"importChanges": true,        # 从原理图导入后画线
              "ops": [{"kind":"line","net":"3.3V","layer":1,
                       "points":[[1000,1000],[2000,1000]],"width":12},
                      {"kind":"via","x":1000,"y":1000,"hole":20,"diameter":40}]}
eda_export   {"kind":"gerber","dir":"D:/out"}
```

### 改原理图（`eda_sch_edit`）

```
eda_sch_edit {"action":"set","dryRun":true,          # 先预演，不写盘
              "edits":[{"designator":"C1","properties":{"Value":"220nF"}}]}
eda_sch_edit {"action":"set",                        # 批量改值 + 移动
              "edits":[{"designator":"C1","properties":{"Value":"220nF"}},
                       {"designator":"R1","x":1000,"y":1500,"rotation":90},
                       {"designator":"C3","newDesignator":"C30"}]}
eda_sch_edit {"action":"replace","edits":[{"designator":"R1","lcsc":"C25804"}]}
eda_sch_edit {"action":"remove","designators":["C2"],"withWires":true}
eda_sch_edit {"action":"add","devices":[{"lcsc":"C1591","x":2900,"y":1000,"designator":"C99"}]}
eda_sch_edit {"action":"wire","wires":[{"net":"SDA","points":[[1200,800],[1600,800]]}]}
eda_sch_edit {"action":"netlabel","labels":[{"net":"SDA","x":1200,"y":800}]}
```

改完用 `eda_schematic` 复查（写入异步落盘，约 1 秒后网表才更新）。

### 改网络（`eda_sch_net`）

```
eda_sch_net {"action":"inspect","designator":"R1","pin":2}     # 这个引脚的网挂在哪根线上
eda_sch_net {"designator":"R1","pin":2,"net":"GND"}             # 三个参数改网络
eda_sch_net {"changes":[{"designator":"R1","pin":2,"net":"GND"},
                        {"designator":"LED1","pin":2,"net":"GND"}]}
eda_sch_net {"action":"netflag","netflag":{"type":"Power","net":"5V","x":2600,"y":1700}}
```

**关键模型（文档没写清，但决定了怎么改）**：

- **一个引脚的网络由它下面那根导线承载**（导线的网络名），不是引脚自己的属性。所以「改某脚的网络」= 找到该脚处的导线并把它的网络名改掉。插件就是这么做的，改完会 `get` 回读确认。
- **电源/地符号是 component，不是 wire**。它靠自身 `Name` 承载网络名。所以引脚如果只接了电源符号、没有导线，`eda_sch_net` 会明确报 `NO_WIRE_AT_PIN` 并列出该位置的符号名，而不是假装改成功。
- 改一根导线会改动**同一根线上的所有引脚**；`inspect` 能先让你看清这一点。
- 网络标签（net label）和导线网络名是两套东西，同时存在时以标签为准，改名前先 `inspect`。

### 原理图分块（`eda_sch_module`）

```
eda_sch_module {"action":"create","name":"电源",                 # 框住这几个器件
                "designators":["U3","C22","C23"]}
eda_sch_module {"action":"create","name":"MCU",                  # 也可以按区域自动收成员
                "region":{"x1":100,"y1":2000,"x2":600,"y2":2400}}
eda_sch_module {"action":"create","name":"按键",                  # 名字写在框外（旧行为）
                "designators":["SW1","R1","C1"], "labelPlacement":"below"}
eda_sch_module {"action":"list"}                                 # 列出所有模块（bbox 实时重算）
eda_sch_module {"action":"locate","name":"电源"}                  # 选中该模块全部器件并缩放到它
eda_sch_module {"action":"delete","name":"电源"}                  # 整块删除：器件 + 块内导线 + 框 + 名字 + 记录
eda_sch_module {"action":"delete","name":"电源","dryRun":true}    # 先看会删掉什么
eda_sch_module {"action":"delete","name":"电源","wires":"attached"} # 更狠：连到块内器件的线全删（含与块外共用的）
```

行为说明：

- 创建时按每个器件**本体包围盒**（`sch_SourcePin.getGeometry` 的 `bodyBBox`，已含旋转与镜像）取并集，外扩 `margin`（默认 30，即 0.3 inch），并写 `模块:<名字>`。
- **名字默认写在框内**（`labelPlacement: "inside"`）：框底会多留一条 `labelBand` 高的横带（默认 ≈ 字号×2.2），名字居中写在这条带里，不压器件；`"below"` 则回到框外下方（用 `labelGap`，默认 60）。
- `locate` / `list` 用的包围盒与创建时一致（含这条名字带），所以缩放不会把名字切掉。
- 同名重复 `create` 会**替换**旧的框和名字，不会叠出两层。
- **框与框自动挨着**（`snap` 默认开）：新框与同页已有模块框的间距 ≤ `snapGap`（默认 300）且两者在另一轴上有重叠时，把新框朝向对方的那条边推到对方边上，形成共用边界；`snappedTo` 会列出贴到了谁、贴的哪一侧。真的重叠（两个模块的器件交错）无法靠外扩解决，会在 `overlapsWith` 里报出来。
  - 只有**新框会动**，已有模块的框不被改动，行为可预期；不想贴就 `"snap": false`。
- **成员归属存在工程文件旁的 sidecar**：`<项目文件>.dsh-modules.json`。所以定位不依赖画布、headless 也能用，工程挪走时把这个 json 一起带走。
- **边框和文字只在可见窗口里能画**。headless 会话里 `sch_PrimitiveText/Rectangle` 根本不存在（`create` 返回 `null`、`getAll` 读不到），此时创建仍会记下成员与 bbox，但返回 `drawn:false` 和原因，不会假装画好了。
- **成员以位号为准**，器件被拖到别处仍属于原模块；`list` 每次都会用当前坐标重算 bbox。
- **工程从 GUI 打开时 `session.path` 是 null**：`<项目>.dsh-modules.json` 仍会被放到工程文件旁边——插件用 `dmt_Project.getCurrentProjectInfo()` 拿到工程名，再用 `teamUuid`（个人工程里它就是工程根目录，如 `D:\...\projects`）拼出真实工程文件并校验存在。都找不到时退回 `%LOCALAPPDATA%\dsh-easyeda\modules\<projectId>.json`，结果里 `storeFallback: true`、`projectFile: null` 会明示这一点。
- **`delete` 删的是整块，不是只删装饰**：默认 `deleteComponents:true` + `wires:"module"`，即删成员器件、删「所有触点都在块内」的导线、删框与名字、删记录。
  - 判定「块内导线」靠引脚几何：先取每个器件的引脚连接点，再看导线被哪些引脚压住；只有**块内引脚碰到、块外引脚没碰到**的才算块内线。
  - 与块外器件共用的线**保留**，并在结果里列进 `wiresKeptShared`（含 `foreignPins` 数量），避免把别的模块的供电/信号剪断。
  - `wires:"attached"` 用 `remove({withWires:true})`，凡接到块内器件的线全删；`wires:"none"` 只删器件不管线（会留下悬空线，慎用）。
  - 删除前建议先 `dryRun`，它会返回 `componentsRemoved` 与 `plannedWires`。

```
eda_pcb_draw   {"ops":[{"kind":"outline",            # 1. 先定板框（layer 11，自动用折线画）
                        "points":[[0,0],[8000,0],[8000,6000],[0,6000]]}]}
eda_pcb_layout {"action":"place","importChanges":true,   # 2. 把原理图导入并把关键器件摆到位
                "moves":[{"designator":"U1","x":4000,"y":3000,"rotation":0}]}
eda_pcb_layout {"action":"auto_layout","waitMs":60000}   # 3. 其余器件自动布局
eda_pcb_layout {"action":"auto_route","waitMs":60000}    # 4. 自动布线（作业模型）
eda_pcb_layout {"action":"job_status","jobId":"..."}     #    仍在跑就续查，不阻塞
eda_pcb        {"drc":true}                              # 5. 检查
eda_export     {"kind":"gerber","dir":"D:/out"}          # 6. 出生产资料
```

## 坐标与图层

- PCB 坐标单位 **mil**；原理图坐标单位为 0.01 inch。
- 铜层：`1` 顶层、`2` 底层、`15+` 内层；板框 `11`（只能用折线画）；丝印 `3/4`。
- 走线、过孔都要按网络名归属，空字符串表示无网络铜箔。

## 实现要点（实测踩坑记录）

这些是写在本插件里的、从真实客户端验证出来的行为，改动脚本时别退回去：

1. **网表要先把图页打开才会生成。** 新会话里 `sch_Netlist.getNetlist()` 直接返回空字符串；必须先 `openDocument(某个原理图页)` + `waitForDocumentReady`。`lib/scripts.js` 用 `ensureNetlist()` 兜底。
2. **工程打开后有加载窗口。** `open` 命令返回的会话里，`getAllSchematicPagesInfo()` / `getAllPcbsInfo()` 可能先返回 `undefined`。判据是 `dmt_Project.waitForReady() === true` **且**两个列表都已经是数组；`waitProject()` 就是这么写的。
3. **BOM 的 `filterOptions` 会毁掉导出。** `getBomFile(base,'xlsx',undefined,[{property:'Add into BOM',includeValue:'yes'}])` 在本版本返回一个内容为 `null` 的 4 字节文件；不传过滤器才能拿到正常的 xlsx。`eda_export` 还会在 Node 侧检查 `bytes <= 8` 并标记 `warning`。
4. **导出前要先激活对应文档。** 原理图的 BOM / 网表需要先打开一个原理图页，PCB 的 Gerber / 坐标文件 / PDF 需要先打开 PCB，否则接口返回 `undefined`。
5. **`pcb_Drc.check()` 返回 boolean**，违规明细在 `pcb_Drc.checkDetailed({})`（`state` / `totalCount` / `violations[]`）。
6. **`saveFileToFileSystem` 要求目标目录已存在**，否则返回 `false` 而不报错；`eda_export` 在 Node 侧先 `mkdir -p`。
7. **PowerShell 抓不到这个 CLI 的 stdout**（官方文档明确写了），但 Node 的 `spawn` 管道可以正常捕获；交互式排查时用 `| Out-String`。
8. 一批绘制操作放在 `pcb_Document.beginCommandGroup` 里，撤销一次即可整组回退。
9. **`importChanges` 是异步落地的。** 它返回 `true` 时 PCB 上往往还没出现器件，紧接着按位号 `place` 会全部 `missing`；`place` 会轮询到目标位号真的出现（最多 25s）再动手。
10. **自动布局/自动布线的作业 ID 与动作无关**（实测两者都返回 `autoroute-N`），不要把 jobId 当类型判断依据，要看 `getAutoJobStatus` 的 `state`（`queued/running/completed/canceled/failed`）。
11. **自动布线需要板框 + 器件。** 没有 11 层板框时引擎会直接拒绝，原始报错只有一句「引擎拒绝或画布未就绪」；插件会先自查并给出可操作的提示。
12. 板框只能用折线画：`pcb_PrimitivePolyline.create('', 11, eda.pcb_MathPolygon.createPolygon([x1,y1,'L',x2,y2,...]), width)`。`pcb_PrimitiveLine.create` 在 11 层不适用。
13. 自动布局/布线是**后台作业**：`waitMs` 用完时若仍在跑，工具会返回 `running: true` 和 `jobId`，用 `action: job_status` 续查；作业会在编辑器里继续跑，不要以为调用返回就等于做完。
14. **源数据写入不抛异常**：`sch_SourcePrimitive*.{update,remove,replace,add,wire,addNetLabel}` 统一返回 `{ ok, value } | { ok: false, error: { code, message } }`，`await` 得到的是结果对象，必须判 `ok`，否则失败会被当成成功。
15. **器件搜索结果不带 `libraryUuid`**（`searchByProperties` / `search` 都是），而 `add` / `replace` 需要它；要用 `lib_LibrariesList.getSystemLibraryUuid()` 补上。文档只在 PCB 侧提过这一点。
16. **原理图写入是异步落盘的**：接口 `ok` 只代表写进 Source，网表要等约 1 秒；插件在每批写入后 `settle` 1.2s。且**没有整组撤销**——批量前先 `dryRun`。
17. **导线连通靠「端点落在别人身上」**：中段十字交叉不算连接；不同网络的共线重叠会被**静默并成一个网络**（返回仍 `ok`）。只连了导线和网络标签、没接任何引脚的网络不会出现在网表里。
18. **`sch_PrimitiveWire.create()` 报 `create failed!` 不给原因**。文档里两条硬约束能解释它：①「WIRE 组即连通性模型」——同网络折线写成多个 WIRE 组，即使端点重合也**不连通**；②入参 `net` 的规则——坐标点落在**多个不同网络的图元**上，或落点图元已显式指定网络而与之冲突，则**创建失败**。插件因此改用 Source 层的 `sch_SourcePrimitiveWire.add`（会返回 `NET_CONFLICT` / `WIRE_GEOMETRY_INVALID` / `NO_CONNECT_BLOCKED` 等错误码），失败时把该段坐标与页码一起带回。
19. **`sch_PrimitivePin.getAll()` 在原理图页返回 0 条**。引脚不是独立图元，必须用 `sch_PrimitiveComponent.getAllPinsByPrimitiveId(器件ID)`，或更好用 `sch_SourcePin.getGeometry()`（一次拿到连接点坐标、所在边、引脚长度、本体包围盒）。
19.1 **器件锚点不是本体中心，别用锚点算框。** `getState_X/Y` 是锚点；按「锚点 + 固定外扩」画模块框会比内容大好几倍（实测 118×80 的内容被画成 675×650）。正确做法：`sch_SourcePin.getGeometry` 取每个器件的 `bodyBBox` 再求并集，外扩量按 0.01inch 单位给小值（默认 30 ≈ 0.3inch）。
19.2 **画布截图可直接导出**：`dmt_EditorControl.getCurrentRenderedAreaImage(tabId)` 返回 PNG 的 Blob，再用 `sys_FileSystem.saveFileToFileSystem(路径, blob)` 落盘——验证「画得对不对」最直接（需可见窗口，目标目录须已存在）。
20. **`sch_PrimitiveComponent.createNetFlag()` 会静默失败**：返回了图元 ID，符号却没落在给的坐标上，也不报错。`eda_sch_net` 的 `netflag` 动作在创建后回读画布坐标与网络名，不一致直接抛错并说明现场有什么。
21. **`ISCH_PrimitiveWire` 的 `net` 读取可能是旧值**（文档明说多图页刷新未解决），所以改名后的回读要重试若干次再判定，否则会把成功误判为失败。
22. **图形图元（文本 / 矩形）只在可见窗口存在。** headless 会话里 `sch_PrimitiveText.create()` 返回 `null`，`sch_PrimitiveRectangle.getAll()` 恒为 0；同一份代码在可见窗口里立刻就能创建并读回。`eda_sch_module` 因此返回 `drawn:false` + 原因，而不是假装画好了。
23. **`sch_SourcePrimitiveRectangle.add()` 在 headless 下会「成功但丢失」**：返回 `{ok:true, primitiveId}`，但会话结束/重开后 `PRIMITIVE_NOT_FOUND`。不要用 Source 层创建矩形；用可见窗口的 `sch_PrimitiveRectangle.create(x, y, width, height)`，其中 `(x, y)` 是**左上角**（原理图 Y 轴向上，即矩形上边）。
24. **功能分组（function groups）不是可以创建的对象。** `sch_SourceDocument.getFunctionGroups` 返回的是内部算法产出的**派生视图**，永不写回工程；只有 `transformFunctionGroup` / `removeFunctionGroup` 能对它操作。想自己定义模块，得自己维护成员表（本插件用 sidecar 文件）。
25. **画布首次 `getAll()` 可能抛 `获取所有器件失败`**：工程刚打开、画布还没就绪时会这样。所有脚本里都带重试（现在改为 45s 时间预算，而不是固定次数），自己写 `eda_run` 时也要重试。
26. **列表类字段一律带截断标记**：网表 `members` 默认只列 12 个，因此每个网络带 `pinCount` / `memberCount`（真实总数）/ `membersTruncated`，顶层带 `netTotal` / `netsTruncated`；组件列表的 `componentTotal`、异常项的 `truncated` 同理。没有标记的截断会让人误判连接数。
27. **GUI 打开的会话 `session.path` 是 `null`**，且 `sys_FileSystem.getProjectsPaths()` 在这种会话里常返回空数组、`getEdaPath()` 返回空串。真正可用的是 `dmt_Project.getCurrentProjectInfo()`：`name` 形如 `/工程名`，`teamUuid` 在个人工程里就是工程根目录（如 `D:\...\projects`），拼出的路径再用 `existsPathInFileSystem` 校验即可。

## 开发与安装

插件是纯 Host 插件（无构建、无依赖），目录即工作区里的 `dsh-easyeda/`：

- 安装/更新：`plugin_manager install_bundle`（target 指向本目录）
- 改完 `index.js` / `lib/*.js` 后需要重启 DSH，或重新安装以加载新的 JavaScript 模块代。
- 不经过 DSH 的自检：直接 `import` 本包的 `lib/cli.js` 与 `lib/scripts.js`，用 `cli.openProject()` 拿到 sessionId，再 `cli.invoke({ sessionId, code: ANALYZE, args })`。`lib/` 只依赖 Node 内置模块，可脱离宿主单独跑。
