# TechMarket — Pipeline CI/CD con Blue-Green y Rollback Automático

## Operación Resiliencia en TechMarket — EFT AUY1104

> **Nota de precisión técnica:** el enunciado original del encargo hace referencia a Amazon EKS y Amazon ECR. Conforme a la aclaración entregada por el docente de la asignatura, dado que K3s implementa la misma API estándar de Kubernetes, esta solución utiliza el clúster **K3s sobre EC2** (aprovisionado en EA1/EA2) y **Docker Hub** como registro de imágenes, resolviendo íntegramente los tres ítems del encargo con dicha infraestructura.

---

## 1. Arquitectura de TechMarket

```
┌─────────────────────┐         ┌──────────────────────────┐
│   GitHub Actions     │         │      EC2 (K3s, 1 nodo)     │
│                      │         │                            │
│  ┌────────────────┐  │  push   │  ┌──────────────────────┐  │
│  │  build (Docker  │──┼────────┼─▶│ Deployment: -blue    │  │
│  │  Hub push)      │  │ image  │  │ Deployment: -green   │  │
│  └────────────────┘  │        │  └──────────┬───────────┘  │
│          │           │        │             │              │
│          ▼           │        │  ┌──────────▼───────────┐  │
│  ┌────────────────┐  │ kubectl│  │ Service (NodePort)    │  │
│  │  deploy         │──┼────────┼─▶│ selector: color=X     │  │
│  │  (Blue-Green +  │  │        │  └──────────────────────┘  │
│  │  health check + │  │        │                            │
│  │  rollback)      │  │        │                            │
│  └────────────────┘  │        └────────────────────────────┘
└──────────────────────┘
```

**Componentes:**

| Componente | Rol |
|---|---|
| **K3s (nodo único sobre EC2)** | Clúster Kubernetes de destino, aprovisionado vía Terraform en `ea2-provision-k8s-sandbox.yaml`. |
| **Docker Hub** (`demianhurtubia/techmarket-orders`) | Registro de imágenes versionadas por el SHA del commit. |
| **`build-push-dockerhub.yml`** (SharedWorkflows) | Plantilla reutilizable: instala dependencias, corre tests (Jest), construye y publica la imagen. |
| **`deploy-blue-green-k3s.yml`** (SharedWorkflows) | Plantilla reutilizable: despliega en el color inactivo, valida salud, mueve tráfico o revierte automáticamente. |
| **`client.yml`** (SharedClient) | Pipeline consumidor que encadena ambas plantillas inyectando variables dinámicas. |
| **Deployments `techmarket-orders-blue` / `-green`** | Dos réplicas del mismo Pod, coexistiendo, diferenciadas por la etiqueta `color`. |
| **Service `techmarket-orders` (NodePort 30090)** | Único punto de entrada; su `selector.color` determina qué Deployment recibe el tráfico. |

---

## 2. Estrategia de despliegue elegida: Blue-Green

### 2.1 Estrategias consideradas

| Estrategia | Downtime | Rollback | Complejidad | Uso típico |
|---|---|---|---|---|
| **All-in-one** | Alto (corte total durante el reemplazo) | Manual, lento | Baja | Entornos de desarrollo, apps no críticas |
| **Rolling Update** | Ninguno, pero con período de versiones mixtas | Automático vía `kubectl rollout undo`, pero revierte pod a pod (lento) | Media | Estándar de Kubernetes por defecto |
| **Canary** | Ninguno | Automático, gradual (requiere control fino de % de tráfico) | Alta (necesita Ingress/mesh avanzado) | Validación progresiva con tráfico real |
| **Blue-Green** (elegida) | Ninguno (corte instantáneo y atómico) | Automático e inmediato (revertir un selector) | Media | Servicios críticos donde se prioriza velocidad de reversión sobre gradualidad |

### 2.2 Por qué Blue-Green para TechMarket Orders

`Orders` es un microservicio crítico: sus caídas afectan directamente la operación de venta. Blue-Green fue seleccionado porque:

1. **Cambio de tráfico atómico**: mover el 100% del tráfico es una sola operación (`kubectl patch service`), no un proceso gradual pod por pod como en Rolling Update — reduce la ventana de exposición a una versión con errores.
2. **Rollback instantáneo**: revertir consiste en aplicar el mismo patch en sentido contrario; no requiere reconstruir ni volver a desplegar nada, a diferencia de Rolling Update donde revertir implica un nuevo rollout.
3. **Validación aislada**: la nueva versión corre en un Deployment completamente separado (`color` distinto) antes de recibir tráfico real, permitiendo el Health Check sin ningún riesgo para los usuarios activos.
4. **Menor complejidad de infraestructura que Canary**: Canary exige control de porcentajes de tráfico (Ingress avanzado o service mesh), no disponible de forma simple en un K3s de nodo único; Blue-Green logra el mismo objetivo de "probar antes de exponer" con un simple `Service` nativo de Kubernetes.

La desventaja aceptada: se duplica el consumo de recursos durante la transición (dos Deployments activos simultáneamente), lo cual es asumible dado que el nodo solo corre 1 réplica por color (`replicas: 1`).

---

## 3. Cómo funciona el pipeline

1. **`build`** (`build-push-dockerhub.yml`): checkout → `npm install` → `npm test` (Jest) → si los tests pasan, build de la imagen Docker etiquetada con `github.sha` y `latest` → push a Docker Hub. Si los tests fallan, el pipeline se detiene aquí (Fail Fast) y nunca se publica una imagen rota.
2. **`deploy`** (`deploy-blue-green-k3s.yml`), recibe la imagen recién publicada vía `needs.build.outputs.image-uri`:
   - Configura `kubectl` contra el K3s remoto usando el kubeconfig almacenado en el secret `KUBECONFIG_K3S`.
   - Determina cuál color está actualmente activo (`live`) y cuál está libre (`idle`), leyendo el `selector.color` del Service.
   - Despliega la nueva imagen únicamente en el Deployment del color `idle`, sin tocar el color `live`.
   - Espera a que el rollout esté listo (`kubectl rollout status --timeout=120s`).
   - **Validación de Salud**: hace `port-forward` al nuevo Deployment y consulta `/health`; solo continúa si recibe HTTP 200.
   - Si la validación es exitosa: aplica un `patch` al Service moviendo el `selector.color` al nuevo color (100% del tráfico) y escala a 0 réplicas el color anterior.
   - Si la validación falla: ejecuta el rollback (ver sección 4).

---

## 4. Cómo se activa la remediación automática (Rollback)

### 4.1 Condiciones que disparan el rollback

El step `ROLLBACK AUTOMÁTICO` se ejecuta automáticamente (`if: failure()`) cuando ocurre cualquiera de estas dos condiciones en los steps previos del mismo job:

1. **Timeout de rollout**: el Deployment del color nuevo no alcanza el estado `Ready` dentro de 120 segundos (cubre `CrashLoopBackOff`, `ImagePullBackOff`, fallos de `Liveness`/`Readiness Probe`, errores de configuración).
2. **Fallo de Health Check**: el endpoint `/health` no responde con HTTP 200 dentro del tiempo esperado.

### 4.2 Qué hace el rollback

```
Detección (rollout timeout / health check ≠ 200)
        │
        ▼
Revertir el selector del Service al color estable anterior
        │
        ▼
Eliminar el Deployment del color que falló
        │
        ▼
El tráfico nunca se movió de la versión estable → cero impacto a usuarios
```

Ningún paso requiere intervención humana: la detección, la decisión y la ejecución del rollback ocurren dentro del mismo job de GitHub Actions, en segundos.

### 4.3 Impacto en MTTR y costos operativos

- **MTTR (Mean Time To Recovery)**: al no requerir intervención manual ni reconstrucción de la versión anterior (el color estable nunca se detiene), el tiempo de recuperación se reduce al tiempo que tarda el propio pipeline en detectar el fallo (~2 minutos con la configuración actual de timeouts), en vez de depender de que una persona note el incidente y actúe manualmente.
- **Costo operativo**: el único costo adicional es mantener temporalmente 2 réplicas activas durante la ventana de validación (segundos a pocos minutos); no se generan costos de infraestructura nueva, ya que ambos colores comparten el mismo nodo K3s.

---

## 5. Cómo probarlo

**Ver el color actualmente activo:**
```bash
kubectl get service techmarket-orders -o jsonpath='{.spec.selector.color}'
```

**Ver ambos Deployments:**
```bash
kubectl get deployments -o wide
```

**Probar el endpoint expuesto:**
```bash
curl http://<IP_PUBLICA_K3S>:30090/health
```

**Forzar un despliegue roto (para observar el rollback):**
Modificar `image-tag` en `client.yml` a un valor que no exista en Docker Hub y hacer push a `main`. El pipeline deberá:
1. Publicar el tag (que no corresponde a una imagen build previa consistente) o fallar en el pull.
2. Fallar el `kubectl rollout status` por `ImagePullBackOff`.
3. Ejecutar automáticamente el step `ROLLBACK AUTOMÁTICO`.
4. Dejar el Service apuntando al color estable, sin impacto para los usuarios.

---

## 6. Repositorios y commits

Todo el desarrollo está documentado mediante commits descriptivos en:
- [`AUY1104-SharedClient`](https://github.com/DemianH9/AUY1104-SharedClient) — manifiestos K8s, pipeline consumidor, código de la API.
- [`AUY1104-SharedWorkflows`](https://github.com/DemianH9/AUY1104-SharedWorkflows) — plantillas reutilizables de GitHub Actions.

---
## 7. Referencias

- Rancher (SUSE). (2024). *K3s Documentation*. https://docs.k3s.io/
- Docker Inc. (2024). *Docker Hub documentation*. https://docs.docker.com/docker-hub/
- GitHub. (2024). *GitHub Actions documentation*. https://docs.github.com/actions
- Kubernetes. (2024). *Deployments*. https://kubernetes.io/docs/concepts/workloads/controllers/deployment/
