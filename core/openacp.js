export async function getOpenAcpStatus(config) {
  const settings = config?.openacp || {}
  if (!settings.enabled) return { ok: true, enabled: false, adapterLoaded: false }

  try {
    await import(settings.adapterPackage || '@openacp/slack-adapter')
    return { ok: true, enabled: true, adapterLoaded: true, adapterPackage: settings.adapterPackage || '@openacp/slack-adapter' }
  } catch (err) {
    return {
      ok: false,
      enabled: true,
      adapterLoaded: false,
      adapterPackage: settings.adapterPackage || '@openacp/slack-adapter',
      error: 'openacp-adapter-not-installed',
      detail: err.code || err.message,
      retryable: false,
    }
  }
}
