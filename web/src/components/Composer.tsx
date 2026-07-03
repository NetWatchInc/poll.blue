import { useEffect, useRef } from "preact/hooks";
import { Editor, Extension } from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";
import Placeholder from "@tiptap/extension-placeholder";
import { Plugin } from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";

// Highlight links / #tags / @mentions inline as you type (visual only — the
// actual facets are derived from the plain text at post time, see lib/richtext).
const FACET_RE = /(https?:\/\/[^\s]+)|((?:^|\s)#[^\s#]{1,64})|((?:^|\s)@[a-zA-Z0-9][a-zA-Z0-9-]*(?:\.[a-zA-Z0-9-]+)+)/g;

const FacetHighlight = Extension.create({
  name: "facetHighlight",
  addProseMirrorPlugins() {
    return [
      new Plugin({
        props: {
          decorations(state) {
            const decos: Decoration[] = [];
            state.doc.descendants((node, pos) => {
              if (!node.isText || !node.text) return;
              const text = node.text;
              FACET_RE.lastIndex = 0;
              let m: RegExpExecArray | null;
              while ((m = FACET_RE.exec(text)) !== null) {
                let from: number;
                let to: number;
                if (m[1]) {
                  from = pos + m.index;
                  to = from + m[1].length;
                } else {
                  const tok = m[2] ?? m[3];
                  const lead = tok.length - tok.trimStart().length;
                  from = pos + m.index + lead;
                  to = pos + m.index + tok.length;
                }
                decos.push(Decoration.inline(from, to, { class: "facet" }));
              }
            });
            return DecorationSet.create(state.doc, decos);
          },
        },
      }),
    ];
  },
});

interface Props {
  value: string;
  onChange: (text: string) => void;
  placeholder?: string;
}

export default function Composer({ value, onChange, placeholder }: Props) {
  const ref = useRef<HTMLDivElement>(null);
  const edRef = useRef<Editor | null>(null);
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;

  useEffect(() => {
    if (!ref.current) return;
    const editor = new Editor({
      element: ref.current,
      extensions: [
        // Plain-text post: keep paragraphs/history, drop all formatting marks.
        StarterKit.configure({
          heading: false, bold: false, italic: false, strike: false, code: false,
          codeBlock: false, blockquote: false, bulletList: false, orderedList: false,
          listItem: false, horizontalRule: false,
        } as Record<string, unknown>),
        Placeholder.configure({ placeholder: placeholder ?? "Say something…" }),
        FacetHighlight,
      ],
      content: value || "",
      editorProps: { attributes: { class: "composer-input" } },
      onUpdate: ({ editor }) => onChangeRef.current(editor.getText()),
    });
    edRef.current = editor;
    return () => { editor.destroy(); edRef.current = null; };
  }, []);

  // Reflect external resets (e.g. "New poll") without disturbing normal typing.
  useEffect(() => {
    const ed = edRef.current;
    if (ed && value !== ed.getText()) ed.commands.setContent(value || "");
  }, [value]);

  return <div ref={ref} class="composer-box"></div>;
}
