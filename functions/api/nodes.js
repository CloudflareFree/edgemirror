import { getNodeConfig } from "../_config/nodes.js";
import { json, corsHeaders } from "../_lib/proxy.js";

export const onRequestOptions = () =>
  new Response(null, { status: 204, headers: corsHeaders() });

/**
 * Static description of the node fleet and services, read from
 * _config/nodes.js. The frontend bootstraps itself from this response, so
 * adding or retiring a node requires no frontend change.
 */
export async function onRequestGet() {
  const { site, nodes, services } = getNodeConfig();
  return json({
    ok: true,
    site: {
      name: site.name,
      version: site.version,
      domain: site.domain,
      tagline: site.tagline,
    },
    nodes: nodes.map((n) => ({
      id: n.id,
      name: n.name,
      region: n.region,
      flag: n.flag,
      kind: n.kind,
      mode: n.mode,
      // The frontend builds mirror URLs client-side for redirect nodes, so
      // the base has to be public. It is already visible to anyone who
      // follows a 302 anyway.
      baseUrl: n.baseUrl || null,
      services: n.services,
      note: n.note,
    })),
    services: services.map((s) => ({
      id: s.id,
      name: s.name,
      short: s.short,
      description: s.description,
      placeholder: s.placeholder,
      examples: s.examples,
    })),
  });
}
