// All user-facing page copy lives in src/content/site.yaml. Pages import `site`
// from here and read text off it, so editing copy means editing that one YAML
// file — no JSX/markup to touch. Parsed once at build time (this is a static
// site), so changes require a rebuild to appear.
import { parse } from "yaml";
import raw from "../content/site.yaml?raw";

export interface Step {
  n: string;
  title: string;
  body: string;
}

export interface DemoOption {
  label: string;
  pct: number;
}

export interface SiteContent {
  site: { title: string; description: string };
  nav: { createLink: string; mineLink: string };
  footer: { creditPrefix: string; creditLabel: string; creditHref: string; tagline: string };
  home: {
    pill: string;
    heroTitleLead: string;
    heroTitleAccent: string;
    heroSubtitle: string;
    ctaPrimary: string;
    ctaSecondary: string;
    demo: { author: string; via: string; question: string; footer: string; options: DemoOption[] };
    how: { title: string; intro: string; steps: Step[] };
    finalCta: { title: string; body: string; button: string };
  };
  create: { title: string; description: string; heading: string; subtitle: string };
  mine: { title: string; heading: string; subtitle: string };
  results: { title: string; makeYourOwn: string };
}

export const site = parse(raw) as SiteContent;
