# ADR 0005: Vulnerabilidades moderadas de `npm audit` en electron-builder (minimatch)

- **Estado:** Aceptada (riesgo asumido temporalmente)
- **Fecha:** 2026-11-19

## Contexto
`npm audit` informa de **6 vulnerabilidades moderadas**, todas por la misma causa:

- **Aviso:** [GHSA-g3hv-75wg-m249](https://github.com/advisories/GHSA-g3hv-75wg-m249). `minimatch` `>=7.0.0 <11.0.1` es vulnerable a una denegación de servicio por amplificación de patrones glob.
- **Cadena:** `electron-builder@26.18.0` → `app-builder-lib@26.18.0` → `@electron/universal@2.0.3` → `minimatch@9.0.9`. El aviso también arrastra `dmg-builder` y `electron-builder-squirrel-windows`, que dependen de `app-builder-lib`.
- **Arreglo propuesto:** el único que ofrece `npm audit fix --force` es **bajar a electron-builder 25.1.0**, una versión mayor anterior.

## Alcance real
- Sólo afecta a **herramientas de compilación** (`devDependencies`). Nada de esto se incluye en la app instalada: el `asar` sólo lleva `dist/`, `dist-electron/` y `package.json`.
- `@electron/universal` sólo se usa para binarios universales de macOS. Este proyecto sólo empaqueta Windows (`--win nsis`).
- La vulnerabilidad necesita patrones glob controlados por un atacante. Los patrones de `electron-builder` salen de nuestro `package.json`.

## Decisión
- No se ejecuta `npm audit fix --force`. Bajar una versión mayor de electron-builder podría cambiar el instalador NSIS (appId, accesos directos, conservación de `%APPDATA%`, ver ADR de actualizaciones) y no aporta seguridad real a la app distribuida.
- Tampoco se fuerza `minimatch@^11` con `overrides`: `app-builder-lib` y `@electron/universal` usan la API de minimatch 3 y 9, y forzarla podría romper el empaquetado sin que lo detecten los tests.

## Plan
- Actualizar `electron-builder` en cuanto publique una versión 26.x (o posterior) que dependa de `minimatch >= 11.0.1`. Después, verificar el instalador con `npm run package` y probar instalación, actualización y desinstalación.
- Volver a ejecutar `npm audit` en cada actualización de dependencias.
