/**
 * Roubaai 资产库 — 无限画布节点插件。
 *
 * 通过宿主的两条只读路由浏览 workspace 的 `.assets`：
 *   GET /api/roubaai-media/assets/tree?path=…   列目录
 *   GET /api/roubaai-media/assets/file?path=…   取文件（图片/视频）
 *
 * 点一张图 = 把它的 URL 写进本节点，于是这个节点就能当上游素材被连线消费
 * （`resource()` 把它报成 image）。插件不复制文件、不碰浏览器存储。
 *
 * 无构建产物：纯 ESM，由宿主注入 React。
 */
export default function roubaaiAssets(runtime) {
  const React = runtime.React;
  const h = runtime.jsx;

  const TREE = "/api/roubaai-media/assets/tree";
  const FILE = "/api/roubaai-media/assets/file";
  const IMAGE = [".png", ".jpg", ".jpeg", ".webp", ".gif", ".avif"];
  const VIDEO = [".mp4", ".webm", ".mov", ".mkv"];

  const extOf = (name) => {
    const dot = name.lastIndexOf(".");
    return dot < 0 ? "" : name.slice(dot).toLowerCase();
  };
  const fileUrl = (path) => `${FILE}?path=${encodeURIComponent(path)}`;
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
      fetch(`${TREE}?path=${encodeURIComponent(dir)}`)
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

  return {
    id: "roubaai-assets",
    name: "Roubaai 资产库",
    version: "0.1.0",
    description: "浏览 workspace 的 .assets：点一张图就用它当本节点内容，可直接连线给下游生成。",
    // A visible marker, so "did the plugin load?" is answerable without guessing:
    // the document carries it, and the console says so once.
    setup: () => {
      if (typeof document !== "undefined") {
        document.documentElement.dataset.roubaaiAssets = "loaded";
        console.info("[roubaai-assets] loaded; node type roubaai-assets:gallery");
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
    ],
  };
}
