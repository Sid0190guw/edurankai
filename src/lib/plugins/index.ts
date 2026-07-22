// src/lib/plugins/index.ts — Block 09 public surface.
export * from './types';
export {
  SUBJECT_PLUGINS, bootstrapPlugins, topoSortPlugins, getPlugin, allPlugins,
  pluginForConcept, resolveAssessmentGenerator, resolveHydrate, scenePrimitiveTypes,
} from './registry';
export { createPluginHost, type PluginHost, type HostCreateInput } from './host';
export { ensurePluginSchema, isPluginEnabled, setPluginEnabled, listPluginState } from './store';
export { NIL_INSTITUTION, PLUGIN_DDL, eduPluginRegistry } from './schema';
