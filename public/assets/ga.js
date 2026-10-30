/**
 * GA4 bootstrap — external so the CSP can stay free of inline-script
 * allowances. Loaded after the async gtag.js tag; gtag.js reads the
 * pre-existing dataLayer, so ordering is safe.
 */
window.dataLayer = window.dataLayer || [];
function gtag() {
  dataLayer.push(arguments);
}
gtag("js", new Date());
gtag("config", "G-CHDLLWY51X");
