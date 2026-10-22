import createDOMPurify, { type DOMPurify } from "dompurify";

// KaTeX 0.16.47's own layout styles (src/domTree.ts:160–184). URL-bearing CSS and custom
// properties are unnecessary for ordinary formulas and must not survive here.
const mathStyleProperties = new Set([
  "background-color", "border-bottom-width", "border-color", "border-right-style",
  "border-right-width", "border-top-width", "border-style", "border-width",
  "bottom", "color", "height", "left", "margin", "margin-left", "margin-right",
  "margin-top", "min-width", "padding-left", "position", "text-shadow", "top",
  "width", "vertical-align",
]);

let mathPurifier: DOMPurify | undefined;

function getMathPurifier(): DOMPurify {
  if (mathPurifier) return mathPurifier;
  const purifier = createDOMPurify(window);
  // Keep this hook on a private instance: other Markdown consumers have their
  // own content rules and must not inherit the formula-only CSS policy.
  purifier.addHook("uponSanitizeAttribute", (_element, event) => {
    if (event.attrName !== "style") return;
    const style = document.createElement("span").style;
    const layout = document.createElement("span").style;
    style.cssText = event.attrValue;
    // Read canonical values so safe border/background shorthands retain their
    // layout/color without retaining their other, potentially loading fields.
    for (const property of mathStyleProperties) {
      const value = style.getPropertyValue(property);
      if (!value || (property === "position" && value !== "relative" && value !== "absolute")) continue;
      layout.setProperty(property, value);
    }
    event.attrValue = layout.cssText;
    if (!event.attrValue) event.keepAttr = false;
  });
  mathPurifier = purifier;
  return purifier;
}

export function sanitizeMathHtml(html: string): string {
  if (!html || typeof window === "undefined") return "";
  return getMathPurifier().sanitize(html, {
    USE_PROFILES: { html: true, svg: true, mathMl: true },
    // KaTeX's accessible MathML uses a text-only TeX annotation. Its XML/HTML
    // integration counterpart stays forbidden below.
    ADD_TAGS: ["semantics", "annotation"],
    FORBID_TAGS: [
      "a", "img", "image", "iframe", "object", "embed", "script", "style", "link",
      "foreignobject", "use", "animate", "animatemotion", "animatetransform", "set",
      "annotation-xml", "form", "input", "button", "textarea", "select", "video",
      "audio", "source", "track", "picture", "base", "meta",
    ],
    FORBID_ATTR: ["href", "src", "xlink:href", "srcset", "action", "formaction", "poster", "background"],
    ALLOW_DATA_ATTR: false,
    SANITIZE_NAMED_PROPS: true,
    RETURN_TRUSTED_TYPE: false,
  });
}
