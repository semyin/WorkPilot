import { useEffect, useState } from "react";
import { call, type Entry, type FileView } from "../file-workbench/api";
import { useWords } from "../workspaceClient";
import { Icon } from "./Icon";
import { MessageBody } from "./MessageBody";

export function ProjectFiles({
  task,
  onManage,
  onBrowser,
}: {
  task: string;
  onManage: () => void;
  onBrowser: () => void;
}) {
  const tr = useWords();
  const [directory, setDirectory] = useState("."),
    [entries, setEntries] = useState<Entry[]>([]);
  const [file, setFile] = useState<FileView | null>(null),
    [path, setPath] = useState<string | null>(null);
  const [error, setError] = useState(""),
    [root, setRoot] = useState(""),
    [loading, setLoading] = useState(true);
  useEffect(() => {
    let live = true;
    setError("");
    setLoading(true);
    setFile(null);
    if (path)
      void call<FileView>(task, { kind: "read_file", path })
        .then((r) => {
          if (live) setFile(r);
        })
        .catch((e) => {
          if (live) setError(String(e));
        })
        .finally(() => {
          if (live) setLoading(false);
        });
    else
      void call<{ root_path: string; listing: { entries: Entry[] } }>(task, {
        kind: "list",
        path: directory,
      })
        .then((r) => {
          if (live) {
            setEntries(r.listing.entries);
            setRoot(r.root_path);
          }
        })
        .catch((e) => {
          if (live) setError(String(e));
        })
        .finally(() => {
          if (live) setLoading(false);
        });
    return () => {
      live = false;
    };
  }, [task, directory, path]);
  return (
    <>
      <h2>{file ? file.path.split(/[\\/]/).at(-1) : tr("项目文件", "Project files")}</h2>
      <div className="wb-panel-caption">
        {file ? file.path : root || tr("当前任务可访问的项目", "Project accessible to this task")}
      </div>
      {(directory !== "." || path) && (
        <button
          className="wb-outline-button"
          onClick={() => {
            if (path) setPath(null);
            else setDirectory(directory.split("/").slice(0, -1).join("/") || ".");
          }}
        >
          {tr("返回上一级", "Go back")}
        </button>
      )}
      {loading && (
        <p role="status" className="wb-panel-caption">
          {tr("正在读取…", "Loading…")}
        </p>
      )}
      {error && (
        <p role="alert" className="error">
          {error}
        </p>
      )}
      {file ? (
        <article className="wb-paper wb-artifact-document">
          {file.text !== null ? (
            <MessageBody text={file.text} />
          ) : (
            <p>
              {tr("此格式可在文件工作区中查看。", "Open the file workspace to view this format.")}
            </p>
          )}
        </article>
      ) : (
        !loading &&
        entries.map((entry) => (
          <button
            type="button"
            className="wb-tree-row"
            key={entry.name}
            onClick={() => {
              const next = directory === "." ? entry.name : directory + "/" + entry.name;
              entry.directory ? setDirectory(next) : setPath(next);
            }}
          >
            <Icon name={entry.directory ? "folder" : "files"} />
            {entry.name}
          </button>
        ))
      )}
      <div className="wb-button-row wb-file-tools">
        <button className="wb-outline-button" type="button" onClick={onManage}>
          <Icon name="terminal" /> {tr("文件与终端", "Files and terminal")}
        </button>
        <button className="wb-outline-button" type="button" onClick={onBrowser}>
          <Icon name="globe" /> {tr("浏览器", "Browser")}
        </button>
      </div>
    </>
  );
}
