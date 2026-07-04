import { useState } from "preact/hooks";
import type { ComponentChildren } from "preact";

// A card whose front flips over to reveal a "back" (used for the technical /
// verification details). Front and back may be plain children, or a function
// that receives a toggle. The corner button lives ON each face, so it flips
// with the card; front shows "i", back shows "✕", both pinned to the exact same
// top-right corner (so it reads as one control that turns with the card). The
// pin is an inline style so it can't be lost to any CSS-cascade surprises.
type Face = ComponentChildren | ((toggle: () => void) => ComponentChildren);

interface Props {
  front: Face;
  back: Face;
  frontClass?: string;
  backClass?: string;
  sceneClass?: string;
  infoLabel?: string; // balloon + aria-label on the front button
}

function renderFace(face: Face, toggle: () => void): ComponentChildren {
  return typeof face === "function" ? (face as (t: () => void) => ComponentChildren)(toggle) : face;
}

// top is tuned to sit on the title row of each face (the h2 on the back, the
// pill/header on the front); right keeps it in the corner.
const CORNER = "position: absolute; top: 1.5rem; right: 0.85rem; z-index: 5";

export default function FlipCard({ front, back, frontClass = "", backClass = "", sceneClass = "", infoLabel = "Details" }: Props) {
  const [flipped, setFlipped] = useState(false);
  const toggle = () => setFlipped((f) => !f);

  return (
    <div class={`flip-scene ${sceneClass}`} style="position: relative">
      <div class={`flip ${flipped ? "is-flipped" : ""}`}>
        <div class={`flip-face flip-front ${frontClass}`} aria-hidden={flipped}>
          {renderFace(front, toggle)}
          <button type="button" class="flip-toggle" onClick={toggle}
            aria-label={infoLabel} style={CORNER}>i</button>
        </div>
        <div class={`flip-face flip-back ${backClass}`} aria-hidden={!flipped}>
          <button type="button" class="flip-toggle" onClick={toggle}
            aria-label="Flip back to the poll" style={CORNER}>✕</button>
          <div class="flip-scroll">{renderFace(back, toggle)}</div>
        </div>
      </div>
    </div>
  );
}
