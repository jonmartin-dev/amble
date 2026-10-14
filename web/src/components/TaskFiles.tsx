import { useQueryClient } from '@tanstack/react-query';
import { AnimatePresence, motion } from 'motion/react';
import { useRef, useState } from 'react';
import AttachFile from '~icons/material-symbols/attach-file-add-rounded';
import AudioFile from '~icons/material-symbols/audio-file-outline-rounded';
import Close from '~icons/material-symbols/close-rounded';
import Description from '~icons/material-symbols/description-outline-rounded';
import Download from '~icons/material-symbols/download-rounded';
import Draft from '~icons/material-symbols/draft-outline-rounded';
import ImageIcon from '~icons/material-symbols/image-outline-rounded';
import Movie from '~icons/material-symbols/movie-outline-rounded';
import Pdf from '~icons/material-symbols/picture-as-pdf-outline-rounded';
import { appUrl, type Task, type TaskFile } from '../lib/api.ts';
import { editTask } from '../lib/local.ts';
import { expressive } from '../lib/motion.ts';
import { refreshViews, useSend } from '../lib/mutations.ts';
import { useSnackbar } from '../lib/snackbar.tsx';
import { useSyncState } from '../lib/sync.ts';
import { useBackToClose } from '../lib/viewport.ts';

// Photos get a smaller copy this many pixels across, for the task page and for Claude.
const PREVIEW_PX = 1600;

const fileUrl = (f: TaskFile, download = false) => appUrl(`/api/files/${f.id}${download ? '?download=1' : ''}`);
const previewUrl = (f: TaskFile) => appUrl(`/api/files/${f.id}/preview`);
// Photos a browser can draw. HEIC (from iPhones) mostly can't, so it shows as a file.
const isPhoto = (f: Pick<TaskFile, 'mime'>) => /^image\/(png|jpeg|gif|webp|avif)$/.test(f.mime);

export function sizeLabel(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(bytes < 10 * 1024 * 1024 ? 1 : 0)} MB`;
}

function FileIcon({ mime, className }: { mime: string; className?: string }) {
  if (mime === 'application/pdf') return <Pdf className={className} aria-hidden />;
  if (mime.startsWith('image/')) return <ImageIcon className={className} aria-hidden />;
  if (mime.startsWith('video/')) return <Movie className={className} aria-hidden />;
  if (mime.startsWith('audio/')) return <AudioFile className={className} aria-hidden />;
  if (mime.startsWith('text/') || mime.includes('document') || mime.includes('msword')) return <Description className={className} aria-hidden />;
  return <Draft className={className} aria-hidden />;
}

/** Sends a file straight to the server, reporting how far along it is. */
function upload(taskId: string, file: File, onProgress: (share: number) => void): Promise<TaskFile> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', appUrl(`/api/tasks/${taskId}/files?name=${encodeURIComponent(file.name)}`));
    xhr.setRequestHeader('Content-Type', file.type || 'application/octet-stream');
    xhr.upload.onprogress = (e) => e.lengthComputable && onProgress(e.loaded / e.total);
    xhr.onload = () => {
      const body = (() => {
        try {
          return JSON.parse(xhr.responseText) as { file?: TaskFile; error?: string };
        } catch {
          return null; // An error page from something in between.
        }
      })();
      if (xhr.status < 300 && body?.file) resolve(body.file);
      else reject(new Error(body?.error ?? `Couldn't add ${file.name} (${xhr.status}).`));
    };
    xhr.onerror = () => reject(new Error(`Couldn't add ${file.name}. Check the connection and try again.`));
    xhr.send(file);
  });
}

/** A smaller copy of a photo, turned the right way up, or null if it's small already or can't be read. */
async function makePreview(file: File): Promise<Blob | null> {
  try {
    const bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' });
    const scale = Math.min(1, PREVIEW_PX / Math.max(bitmap.width, bitmap.height));
    if (scale === 1 && file.size < 500_000) return null;
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(bitmap.width * scale);
    canvas.height = Math.round(bitmap.height * scale);
    canvas.getContext('2d')!.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    bitmap.close();
    const encode = (type: string) => new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, type, 0.82));
    // Safari can't write WebP and quietly hands back a PNG; JPEG is smaller then.
    const webp = await encode('image/webp');
    return webp?.type === 'image/webp' ? webp : await encode('image/jpeg');
  } catch {
    return null;
  }
}

/** A photo or file with no copy on this device yet shows its icon instead. */
function Thumb({ file }: { file: TaskFile }) {
  const [failed, setFailed] = useState(false);
  if (failed) {
    return (
      <span className="grid size-full place-items-center bg-surface-high text-on-surface-variant">
        <ImageIcon className="size-8" aria-hidden />
      </span>
    );
  }
  return <img src={file.preview ? previewUrl(file) : fileUrl(file)} alt={file.name} loading="lazy" decoding="async" onError={() => setFailed(true)} className="size-full object-cover" />;
}

/** A photo filling the screen, with a way to open the original. */
function Viewer({ file, onClose }: { file: TaskFile | null; onClose: () => void }) {
  useBackToClose(file != null, onClose);
  return (
    <AnimatePresence>
      {file && (
        <motion.div
          role="dialog"
          aria-label={file.name}
          className="fixed inset-0 z-40 flex flex-col bg-black text-white"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0, pointerEvents: 'none' }}
          onClick={onClose}
        >
          <div className="flex shrink-0 items-center gap-2 px-2 pt-2" style={{ paddingTop: 'max(0.5rem, env(safe-area-inset-top))' }} onClick={(e) => e.stopPropagation()}>
            <button type="button" onClick={onClose} aria-label="Close" className="grid size-12 place-items-center rounded-full hover:bg-white/10">
              <Close className="size-6" aria-hidden />
            </button>
            <p className="min-w-0 flex-1 truncate text-sm">{file.name}</p>
            <a href={fileUrl(file, true)} download={file.name} aria-label="Download the original" className="grid size-12 place-items-center rounded-full hover:bg-white/10">
              <Download className="size-6" aria-hidden />
            </a>
          </div>
          <motion.img
            src={fileUrl(file)}
            alt={file.name}
            className="min-h-0 flex-1 object-contain p-3"
            initial={{ scale: 0.94 }}
            animate={{ scale: 1 }}
            exit={{ scale: 0.96 }}
            transition={expressive.defaultSpatial}
            // A photo can be the preview first and sharpen when the full one arrives.
            style={file.preview ? { backgroundImage: `url(${previewUrl(file)})`, backgroundSize: 'contain', backgroundPosition: 'center', backgroundRepeat: 'no-repeat', backgroundOrigin: 'content-box' } : undefined}
          />
        </motion.div>
      )}
    </AnimatePresence>
  );
}

/**
 * The files on a task: photos as tiles, anything else as a row. Adding one needs a connection; the
 * file goes straight to the server, then a smaller copy of a photo follows for quick showing.
 * Removing works offline and can be undone.
 */
export function TaskFiles({ task }: { task: Task }) {
  const qc = useQueryClient();
  const snack = useSnackbar();
  const send = useSend();
  const { online } = useSyncState();
  const picker = useRef<HTMLInputElement>(null);
  const [uploads, setUploads] = useState<{ key: string; name: string; progress: number }[]>([]);
  const [viewing, setViewing] = useState<TaskFile | null>(null);

  const photos = task.files.filter(isPhoto);
  const others = task.files.filter((f) => !isPhoto(f));

  const add = async (files: File[]) => {
    for (const file of files) {
      const key = crypto.randomUUID();
      setUploads((u) => [...u, { key, name: file.name, progress: 0 }]);
      try {
        const saved = await upload(task.id, file, (progress) => setUploads((u) => u.map((x) => (x.key === key ? { ...x, progress } : x))));
        editTask(qc, task.id, (t) => ({ files: [...t.files.filter((f) => f.id !== saved.id), saved] }));
        if (isPhoto(saved)) {
          const preview = await makePreview(file);
          if (preview) {
            const res = await fetch(appUrl(`/api/files/${saved.id}/preview`), { method: 'POST', headers: { 'Content-Type': preview.type }, body: preview }).catch(() => null);
            if (res?.ok) editTask(qc, task.id, (t) => ({ files: t.files.map((f) => (f.id === saved.id ? { ...f, preview: true } : f)) }));
          }
        }
      } catch (e) {
        snack({ message: (e as Error).message });
      } finally {
        setUploads((u) => u.filter((x) => x.key !== key));
      }
    }
    refreshViews(qc, ['task', 'activity']);
  };

  const setRemoved = (file: TaskFile, removed: boolean) => {
    editTask(qc, task.id, (t) => ({
      files: removed ? t.files.filter((f) => f.id !== file.id) : [...t.files.filter((f) => f.id !== file.id), file].sort((a, b) => a.createdAt.localeCompare(b.createdAt)),
    }));
    send(removed ? 'DELETE' : 'POST', `/files/${file.id}${removed ? '' : '/restore'}`, removed ? undefined : {}, `${removed ? 'Remove' : 'Restore'} ${file.name}`);
  };
  const remove = (file: TaskFile) => {
    setRemoved(file, true);
    setViewing(null);
    snack({ message: `Removed ${file.name}`, action: { label: 'Undo', run: () => setRemoved(file, false) } });
  };

  const removeButton = (file: TaskFile, onImage = false) => (
    <button
      type="button"
      onClick={(e) => {
        e.stopPropagation();
        remove(file);
      }}
      aria-label={`Remove ${file.name}`}
      className={`grid size-9 shrink-0 place-items-center rounded-full ${onImage ? 'absolute top-1 right-1 bg-black/45 text-white' : 'text-on-surface-variant hover:bg-surface-high'}`}
    >
      <Close className="size-5" aria-hidden />
    </button>
  );

  return (
    <div className="flex flex-col gap-2 rounded-[1.75rem] bg-surface-low p-2">
      {(photos.length > 0 || uploads.length > 0) && (
        <ul className="grid grid-cols-3 gap-2">
          <AnimatePresence initial={false}>
            {photos.map((f) => (
              <motion.li key={f.id} layout initial={{ opacity: 0, scale: 0.9 }} animate={{ opacity: 1, scale: 1 }} exit={{ opacity: 0, scale: 0.9 }} transition={expressive.fastSpatial} className="relative aspect-square overflow-hidden rounded-2xl">
                <button type="button" onClick={() => setViewing(f)} aria-label={`Open ${f.name}`} className="size-full">
                  <Thumb file={f} />
                </button>
                {removeButton(f, true)}
              </motion.li>
            ))}
            {uploads.map((u) => (
              <motion.li key={u.key} layout initial={{ opacity: 0, scale: 0.9 }} animate={{ opacity: 1, scale: 1 }} exit={{ opacity: 0 }} className="grid aspect-square place-items-center rounded-2xl bg-surface-high px-2 text-center">
                <span>
                  <span className="block text-sm font-medium">{Math.round(u.progress * 100)}%</span>
                  <span className="mt-1 block truncate text-xs text-on-surface-variant">{u.name}</span>
                </span>
              </motion.li>
            ))}
          </AnimatePresence>
        </ul>
      )}
      {others.length > 0 && (
        <ul className="flex flex-col gap-1">
          {others.map((f) => (
            <li key={f.id} className="flex items-center gap-3 rounded-2xl px-2 py-1">
              <FileIcon mime={f.mime} className="size-5 shrink-0 text-on-surface-variant" />
              <a href={fileUrl(f)} target="_blank" rel="noreferrer" className="min-w-0 flex-1 py-2">
                <span className="block truncate text-primary">{f.name}</span>
                <span className="block text-xs text-on-surface-variant">{sizeLabel(f.size)}</span>
              </a>
              <a href={fileUrl(f, true)} download={f.name} aria-label={`Download ${f.name}`} className="grid size-9 place-items-center rounded-full text-on-surface-variant hover:bg-surface-high">
                <Download className="size-5" aria-hidden />
              </a>
              {removeButton(f)}
            </li>
          ))}
        </ul>
      )}
      <button
        type="button"
        disabled={!online}
        onClick={() => picker.current?.click()}
        className="flex items-center gap-3 rounded-2xl px-3 py-2.5 text-left text-on-surface-variant transition-colors hover:bg-surface-high disabled:opacity-50"
      >
        <AttachFile className="size-5" aria-hidden />
        <span>{online ? 'Add a photo or file' : 'Adding files needs a connection'}</span>
      </button>
      <input
        ref={picker}
        type="file"
        multiple
        hidden
        onChange={(e) => {
          const files = Array.from(e.target.files ?? []);
          e.target.value = '';
          if (files.length) void add(files);
        }}
      />
      <Viewer file={viewing} onClose={() => setViewing(null)} />
    </div>
  );
}
