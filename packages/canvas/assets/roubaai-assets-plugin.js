/**
 * Roubaai 资产库 — 无限画布节点插件。
 *
 * 通过宿主的两条只读路由浏览 workspace 的 `.assets`：
 *   GET /api/roubaai-assets/tree?path=…   列目录
 *   GET /api/roubaai-assets/file?path=…   取文件（图片/视频）
 *
 * 点一张图 = 把它的 URL 写进本节点，于是这个节点就能当上游素材被连线消费
 * （`resource()` 把它报成 image）。插件不复制文件、不碰浏览器存储。
 *
 * 第二个节点「Roubaai 蓝图」把一份 JSON 铺成节点与连线（剧本 → 分镜 → 参考图 →
 * 视频），用的是画布自己的 `applyOps`，因此连线可见、可审、可手改。蓝图放在
 * `<workspace>/.assets/<项目>/canvas-blueprint.json`：
 *
 *   {
 *     "version": 1,
 *     "nodes": [
 *       { "id": "script",  "type": "text",  "title": "剧本",   "content": "…" },
 *       { "id": "shots",   "type": "text",  "title": "分镜",   "content": "…" },
 *       { "id": "ref-s1",  "type": "image", "title": "S01 参考", "url": "…", "prompt": "…" },
 *       { "id": "shot-s1", "type": "video", "title": "S01",    "prompt": "…" }
 *     ],
 *     "connections": [["script", "shots"], ["ref-s1", "shot-s1"]]
 *   }
 *
 * `id` 只在蓝图内部有效，套用时会被换成画布节点 id；节点位置由列布局自动排，
 * 蓝图不必关心像素。
 *
 * 无构建产物：纯 ESM，由宿主注入 React。
 */

/** Stage per node type: the column a node lands in, left to right. */
const BLUEPRINT_STAGES = { text: 0, config: 0, image: 1, video: 2, audio: 2 };

const BLUEPRINT_COLUMN_WIDTH = 380;
const BLUEPRINT_ROW_HEIGHT = 260;

/**
 * Turn a blueprint into the canvas ops that realise it.
 *
 * Exported for tests: the mapping is the part worth checking, and it needs no DOM.
 * @param blueprint - the parsed blueprint file.
 * @param origin - where the first column starts.
 * @returns the ops to hand to `ctx.applyOps`.
 */
export function blueprintOps(blueprint, origin = { x: 0, y: 0 }) {
  const ops = [];
  const ids = new Map();
  const rows = {};
  const nodes = Array.isArray(blueprint && blueprint.nodes) ? blueprint.nodes : [];
  // A per-apply stamp keeps two applications of the same blueprint from colliding
  // on node ids.
  const stamp = Math.random().toString(36).slice(2, 7);
  nodes.forEach((entry, index) => {
    const name = typeof entry?.id === "string" && entry.id ? entry.id : `node-${index + 1}`;
    const type = typeof entry?.type === "string" && entry.type ? entry.type : "text";
    const stage = BLUEPRINT_STAGES[type] ?? 1;
    const row = rows[stage] ?? 0;
    rows[stage] = row + 1;
    const id = `bp-${stamp}-${name}`;
    ids.set(name, id);
    ops.push({
      type: "add_node",
      id,
      nodeType: type,
      title: typeof entry?.title === "string" && entry.title ? entry.title : name,
      position: { x: origin.x + stage * BLUEPRINT_COLUMN_WIDTH, y: origin.y + row * BLUEPRINT_ROW_HEIGHT },
      metadata: blueprintMetadata(type, entry),
    });
  });
  const connections = Array.isArray(blueprint && blueprint.connections) ? blueprint.connections : [];
  for (const pair of connections) {
    const from = Array.isArray(pair) ? ids.get(pair[0]) : undefined;
    const to = Array.isArray(pair) ? ids.get(pair[1]) : undefined;
    if (from !== undefined && to !== undefined) ops.push({ type: "connect_nodes", fromNodeId: from, toNodeId: to });
  }
  return ops;
}

/** Only the metadata each node type actually reads, so nothing invents a field. */
function blueprintMetadata(type, entry) {
  const prompt = typeof entry?.prompt === "string" ? entry.prompt : "";
  if (type === "text") return { content: typeof entry?.content === "string" ? entry.content : "" };
  if (type === "image") return { content: typeof entry?.url === "string" ? entry.url : "", prompt };
  if (type === "video") return { prompt };
  if (type === "audio") return { content: typeof entry?.url === "string" ? entry.url : "", prompt };
  if (type === "config") {
    return {
      ...(typeof entry?.model === "string" ? { model: entry.model } : {}),
      ...(typeof entry?.size === "string" ? { size: entry.size } : {}),
      ...(typeof entry?.quality === "string" ? { quality: entry.quality } : {}),
      ...(entry?.count === undefined ? {} : { count: Number(entry.count) || 1 }),
    };
  }
  return {};
}

export default function roubaaiAssets(runtime) {
  const React = runtime.React;
  const h = runtime.jsx;

  const TREE = "/api/roubaai-assets/tree";
  const FILE = "/api/roubaai-assets/file";
  const IMAGE = [".png", ".jpg", ".jpeg", ".webp", ".gif", ".avif"];
  const VIDEO = [".mp4", ".webm", ".mov", ".mkv"];

  // The canvas is opened for one session, and the host resolves that session's
  // workspace itself: the browser names an id, never a directory. Routes without
  // it fall back to the host's default tree.
  const SESSION = new URLSearchParams(window.location.search).get("ds") ?? "";
  const withSession = (url) => SESSION === "" ? url : `${url}${url.includes("?") ? "&" : "?"}session=${encodeURIComponent(SESSION)}`;

  const extOf = (name) => {
    const dot = name.lastIndexOf(".");
    return dot < 0 ? "" : name.slice(dot).toLowerCase();
  };
  const fileUrl = (path) => withSession(`${FILE}?path=${encodeURIComponent(path)}`);
  const isImage = (name) => IMAGE.includes(extOf(name));
  const isVideo = (name) => VIDEO.includes(extOf(name));

  function Gallery({ ctx }) {
    const [dir, setDir] = React.useState("");
    const [entries, setEntries] = React.useState([]);
    const [status, setStatus] = React.useState("读取中…");
    const content = ctx.node.metadata && ctx.node.metadata.content;

    React.useEffect(() => {
      let alive = true;
      setStatus("读取中…");
      fetch(withSession(`${TREE}?path=${encodeURIComponent(dir)}`))
        .then((response) => response.json())
        .then((json) => {
          if (!alive) return;
          const list = Array.isArray(json.entries) ? json.entries : [];
          setEntries(list);
          setStatus(list.length === 0 ? "空目录" : `${list.length} 项`);
        })
        .catch(() => {
          if (!alive) return;
          setEntries([]);
          setStatus("读不到资产目录");
        });
      return () => {
        alive = false;
      };
    }, [dir]);

    const button = (label, onClick, key) =>
      h(
        "button",
        {
          key,
          type: "button",
          onClick,
          style: {
            border: "1px solid rgba(128,128,128,.35)",
            background: "transparent",
            color: "inherit",
            borderRadius: 6,
            padding: "2px 8px",
            cursor: "pointer",
            font: "inherit",
          },
        },
        label,
      );

    const header = h(
      "div",
      { style: { display: "flex", alignItems: "center", gap: 6, padding: "6px 8px", fontSize: 12, opacity: 0.85 } },
      dir === "" ? null : button("← 返回", () => setDir(dir.split("/").slice(0, -1).join("/"))),
      h("span", { style: { flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" } }, dir === "" ? ".assets" : dir),
      h("span", { style: { opacity: 0.6 } }, status),
      content ? button("清除", () => ctx.updateMetadata({ content: undefined })) : null,
    );

    const body = content
      ? h("img", { src: content, alt: "", style: { width: "100%", height: "100%", objectFit: "contain", background: "#0001" } })
      : h(
          "div",
          {
            style: {
              display: "grid",
              gridTemplateColumns: "repeat(auto-fill,minmax(84px,1fr))",
              gap: 6,
              padding: 8,
              overflow: "auto",
              height: "100%",
              alignContent: "start",
            },
          },
          entries.map((entry) => {
            if (entry.dir) {
              return h(
                "button",
                {
                  key: entry.path,
                  type: "button",
                  onClick: () => setDir(entry.path),
                  style: {
                    border: "1px dashed rgba(128,128,128,.4)",
                    background: "transparent",
                    color: "inherit",
                    borderRadius: 6,
                    padding: "10px 4px",
                    cursor: "pointer",
                    fontSize: 11,
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                  },
                },
                `📁 ${entry.name}`,
              );
            }
            if (!isImage(entry.name) && !isVideo(entry.name)) {
              return h(
                "div",
                { key: entry.path, style: { fontSize: 11, opacity: 0.6, padding: "4px 2px", wordBreak: "break-all" } },
                entry.name,
              );
            }
            const media = isVideo(entry.name)
              ? h("video", { src: fileUrl(entry.path), muted: true, preload: "metadata", style: { width: "100%", height: 56, objectFit: "cover" } })
              : h("img", { src: fileUrl(entry.path), loading: "lazy", alt: entry.name, style: { width: "100%", height: 56, objectFit: "cover" } });
            return h(
              "button",
              {
                key: entry.path,
                type: "button",
                title: entry.path,
                onClick: () => ctx.updateMetadata({ content: fileUrl(entry.path) }),
                style: { border: "1px solid rgba(128,128,128,.3)", background: "transparent", padding: 0, borderRadius: 6, cursor: "pointer", overflow: "hidden" },
              },
              media,
              h(
                "div",
                { style: { fontSize: 10, padding: "2px 4px", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", color: "inherit" } },
                entry.name,
              ),
            );
          }),
        );

    return h(
      "div",
      { style: { display: "flex", flexDirection: "column", height: "100%", background: ctx.theme.node.panel, color: ctx.theme.node.text } },
      header,
      h("div", { style: { flex: 1, minHeight: 0 } }, body),
    );
  }

  function Blueprint({ ctx }) {
    const [projects, setProjects] = React.useState([]);
    const [status, setStatus] = React.useState("读取中…");
    const [busy, setBusy] = React.useState("");

    React.useEffect(() => {
      let alive = true;
      fetch(withSession(`${TREE}?path=`))
        .then((response) => response.json())
        .then((json) => {
          if (!alive) return;
          const dirs = (Array.isArray(json.entries) ? json.entries : []).filter((entry) => entry.dir);
          setProjects(dirs);
          setStatus(dirs.length === 0 ? "还没有项目目录" : `${dirs.length} 个项目`);
        })
        .catch(() => {
          if (!alive) return;
          setProjects([]);
          setStatus("读不到资产目录");
        });
      return () => {
        alive = false;
      };
    }, []);

    const apply = async (project) => {
      setBusy(project);
      setStatus(`正在套用「${project}」…`);
      try {
        // The blueprint is an ordinary file in the project's asset directory, so
        // the same read route serves it — no second protocol to keep in sync.
        const response = await fetch(fileUrl(`${project.path}/canvas-blueprint.json`));
        if (!response.ok) {
          setStatus(`「${project.name}」里没有 canvas-blueprint.json`);
          return;
        }
        const blueprint = await response.json();
        const ops = blueprintOps(blueprint, { x: ctx.node.position.x + ctx.node.width + 80, y: ctx.node.position.y });
        if (ops.length === 0) {
          setStatus("蓝图里没有节点");
          return;
        }
        ctx.applyOps(ops);
        const nodes = ops.filter((op) => op.type === "add_node").length;
        const links = ops.filter((op) => op.type === "connect_nodes").length;
        setStatus(`已铺 ${nodes} 个节点、${links} 条连线`);
      } catch (error) {
        setStatus(`套用失败：${error && error.message ? error.message : error}`);
      } finally {
        setBusy("");
      }
    };

    const row = (project) =>
      h(
        "button",
        {
          key: project.path,
          type: "button",
          disabled: busy !== "",
          onClick: () => void apply(project),
          style: {
            border: "1px solid rgba(128,128,128,.3)",
            background: "transparent",
            color: "inherit",
            borderRadius: 6,
            padding: "6px 8px",
            cursor: busy === "" ? "pointer" : "default",
            textAlign: "left",
            font: "inherit",
            opacity: busy !== "" && busy !== project.path ? 0.5 : 1,
          },
        },
        busy === project.path ? `⏳ ${project.name}` : `🧩 ${project.name}`,
      );

    return h(
      "div",
      { style: { display: "flex", flexDirection: "column", height: "100%", background: ctx.theme.node.panel, color: ctx.theme.node.text } },
      h(
        "div",
        { style: { padding: "6px 8px", fontSize: 12, opacity: 0.85, display: "flex", gap: 6, alignItems: "center" } },
        h("span", { style: { flex: 1 } }, "套用蓝图"),
        h("span", { style: { opacity: 0.6 } }, status),
      ),
      h(
        "div",
        { style: { flex: 1, minHeight: 0, overflow: "auto", display: "flex", flexDirection: "column", gap: 6, padding: 8 } },
        projects.length === 0
          ? h("div", { style: { fontSize: 11, opacity: 0.6 } }, "把 canvas-blueprint.json 放进 <项目>/ 目录，然后刷新")
          : projects.map(row),
      ),
    );
  }

  return {
    id: "roubaai-assets",
    name: "Roubaai 资产库",
    version: "0.1.0",
    description: "浏览 workspace 的 .assets：点一张图就用它当本节点内容，可直接连线给下游生成；蓝图节点把一份 JSON 铺成节点与连线。",
    // A visible marker, so "did the plugin load?" is answerable without guessing:
    // the document carries it, and the console says so once.
    setup: () => {
      if (typeof document !== "undefined") {
        document.documentElement.dataset.roubaaiAssets = "loaded";
        console.info("[roubaai-assets] loaded; node types roubaai-assets:gallery, roubaai-assets:blueprint");
      }
    },
    nodes: [
      {
        type: "roubaai-assets:gallery",
        title: "Roubaai 资产",
        icon: "🗂️",
        description: "从 .assets 选素材",
        defaultSize: { width: 420, height: 340 },
        defaultMetadata: {},
        Content: Gallery,
        // Downstream generation reads this: once an asset is picked, the node
        // offers it as an image resource.
        resource: (node) => {
          const url = node.metadata && node.metadata.content;
          return typeof url === "string" && url !== "" ? { kind: "image", url } : null;
        },
        toolbar: (ctx) =>
          ctx.node.metadata && ctx.node.metadata.content
            ? [
                {
                  id: "roubaai-assets:clear",
                  title: "清除所选素材",
                  label: "清除",
                  icon: "✕",
                  danger: true,
                  onClick: () => ctx.updateMetadata({ content: undefined }),
                },
              ]
            : [],
      },
      {
        type: "roubaai-assets:blueprint",
        title: "Roubaai 蓝图",
        icon: "🧩",
        description: "把 <项目>/canvas-blueprint.json 铺成节点与连线",
        defaultSize: { width: 300, height: 300 },
        defaultMetadata: {},
        hidePanel: true,
        Content: Blueprint,
      },
    ],
  };
}
