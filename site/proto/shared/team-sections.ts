// Build-time HTML sections for the "Meet your team" page (site/proto/team/). Owned by the team-page work; merged into SECTIONS by
// sections.ts. Add entries as `"team-story": (page) => html`.
export const TEAM_SECTIONS: Record<string, (page: string) => string> = {};
