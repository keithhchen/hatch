import React, { useState } from "react";
import { IconButton, SearchInput, Spinner } from "@hatch/ui";
import { FileText, Trash2 } from "lucide-react";
import { FILTER_FROM, groupFiles } from "./fileListModel.js";
import "./fileList.css";

const BUSY = new Set(["uploading", "ingesting"]);

/**
 * Every place a node shows files: compact rows grouped by folder, filterable, name column then actions column.
 * A record is `{ path, status?, error? }`; `status` is only set while the file is not settled.
 */
export function FileList({ title, records, onOpen, onDelete, deletable = () => true, statusLabel, t }) {
  const [query, setQuery] = useState("");
  const groups = groupFiles(records, query);
  return <section className="fl">
    {title || records.length >= FILTER_FROM ? <header className="fl__head">
      {title ? <strong>{title}</strong> : null}
      <span className="fl__count">{t("fileCount", records.length)}</span>
      {records.length >= FILTER_FROM ? <SearchInput className="fl__search" value={query} onChange={event => setQuery(event.target.value)} onClear={() => setQuery("")} placeholder={t("filterFiles")} aria-label={t("filterFiles")} /> : null}
    </header> : null}
    {groups.length ? groups.map(group => <div className="fl__group" key={group.folder}>
      {groups.length > 1 || group.folder ? <h4 className="fl__folder">{group.folder || t("filesRoot")}</h4> : null}
      <ul>{group.records.map(record => {
        const busy = BUSY.has(record.status);
        const failed = record.status === "failed" || record.status === "partial";
        const openable = !record.status;
        return <li key={record.path} className={`fl__row${failed ? " is-failed" : ""}`}>
          <button type="button" className="fl__name" disabled={!openable} onClick={() => onOpen?.(record.path)} title={record.name}>
            <FileText aria-hidden="true" />
            <span className="fl__label">{record.name}</span>
            {record.status ? <small className="fl__state" title={record.error || undefined}>{[statusLabel?.(record), record.error].filter(Boolean).join(": ")}</small> : null}
          </button>
          <span className="fl__actions">
            {busy ? <Spinner label={statusLabel?.(record)} size="small" /> : null}
            {onDelete && !busy && deletable(record) ? <IconButton label={t("removeFile", record.path)} size="small" onClick={() => onDelete(record)}><Trash2 aria-hidden="true" /></IconButton> : null}
          </span>
        </li>;
      })}</ul>
    </div>) : <p className="fl__empty">{t("noFiles")}</p>}
  </section>;
}
