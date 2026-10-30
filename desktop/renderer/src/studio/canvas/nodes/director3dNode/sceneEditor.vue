<template>
  <el-dialog
    class="directorDialog"
    :modelValue="visible"
    fullscreen
    :transition="{ name: 'director', css: false }"
    appendToBody
    :showClose="false"
    :closeOnClickModal="false"
    :closeOnPressEscape="false"
    :beforeClose="closeEditor"
    @closed="emit('close')">
    <template #header>
      <div class="directorHeader">
        <el-button class="closeButton" :icon="IconX" text circle :aria-label="translate('关闭')" @click="closeEditor" />
        <icon-cube3d-sphere :size="18" aria-hidden="true" />
        <span>{{ translate('导演台') }}</span>
        <small v-if="result">{{ planTitle }}</small>
        <div class="headerTools"><el-button :icon="IconArrowBackUp" text :disabled="!canUndo || editLocked" :aria-label="translate('撤销布景')" @click="emit('history', 'undo')" /><el-button :icon="IconArrowForwardUp" text :disabled="!canRedo || editLocked" :aria-label="translate('重做布景')" @click="emit('history', 'redo')" /><span class="headerBadge">{{ translate('3D 预演') }}</span></div>
      </div>
    </template>
    <div ref="workspace" class="directorWorkspace" :style="{ '--leftWidth': panelWidth.left + 'px', '--rightWidth': panelWidth.right + 'px' }" @keydown="handleEditorShortcut">
      <div class="leftWorkspace">
        <div class="panelResizer" role="separator" aria-orientation="vertical" tabindex="0" :aria-label="translate('调整左侧面板宽度')" :aria-valuenow="panelWidth.left" @pointerdown="startPanelResize($event, 'left')" @dblclick="setPanelWidth('left', panelLimits.left[2])" @keydown.left.prevent="setPanelWidth('left', panelWidth.left - 16)" @keydown.right.prevent="setPanelWidth('left', panelWidth.left + 16)" />
        <nav class="directorRail" :aria-label="translate('场景工具')">
          <button :class="{ active: leftPanel === 'scene' && !assetsOpen }" :title="translate('场景')" :aria-label="translate('场景')" @click="openLeftPanel('scene'); showSceneProperties()"><icon-stack-2 :size="18"/></button>
          <button :class="{ active: leftPanel === 'actors' }" :disabled="processing" :title="translate('添加角色')" :aria-label="translate('添加角色')" @click="openLeftPanel('actors')"><icon-user-plus :size="18"/></button>
          <button :class="{ active: leftPanel === 'cameras' }" :disabled="processing" :title="translate('添加机位')" :aria-label="translate('添加机位')" @click="openLeftPanel('cameras')"><icon-camera-plus :size="18"/></button>
          <button :title="translate('全景背景')" :aria-label="translate('全景背景')" @click="showSceneProperties"><icon-photo-plus :size="18"/></button>
          <button :class="{ active: leftPanel === 'ratio' }" :title="translate('画面比例')" :aria-label="translate('画面比例')" @click="openLeftPanel('ratio')"><icon-aspect-ratio :size="18"/></button>
          <button :class="{ active: leftPanel === 'scene' && assetsOpen }" :title="translate('布景库')" :aria-label="translate('布景库')" @click="openLeftPanel('assets')"><icon-cube3d-sphere :size="18"/></button>
        </nav>
      <stageAddPanel v-if="leftPanel !== 'scene'" v-model:aspectRatio="aspectRatio" :panel="leftPanel" :disabled="processing" :hasSubject="scene.objectList.some(object => object.objType === 'mannequin')" @addActor="(bodyType, crowd) => emit('addMannequin', { bodyType, crowd })" @addCamera="addCameraPreset" @openAssets="openLeftPanel('assets')" />
      <sceneOutline v-show="leftPanel === 'scene'" ref="outlineView" view="outline"
        v-model:selectedId="selectedObjectId"
        :objects="scene.objectList"
        :cameraCount="anchors.length"
        :selectionDisabled="processing"
        :animatedIds="result?.tracks.map(track => track.objectId)"
        :disabled="editLocked"
        @addActor="emit('addMannequin')" @addObjects="emit('addObjects', $event)" @focus="focusObject" @duplicate="emit('duplicateObject', $event)" @ungroup="emit('ungroupAsset', $event)" @remove="emit('removeObject', $event)"
        @preview="previewObject"
        @commit="(id, patch) => emit('updateObject', id, patch)">
        <template #cameras="{ query }">
          <button v-for="item in cameraEntries(query)" :key="item.anchor.id" type="button" role="option" class="cameraTreeItem" :class="{ selected: selectedCamera?.id === item.anchor.id }" :aria-selected="selectedCamera?.id === item.anchor.id" :disabled="processing" @click="selectAnchor(item.anchor.id)" @dblclick="restoreAnchor(item.anchor)"><icon-camera :size="15"/><span>{{ item.name }}</span></button>
        </template>
        <template #actions>
          <el-tooltip :content="translate('添加人偶')" placement="top" :showArrow="false" :hideAfter="0" :persistent="false">
            <el-button class="addObject" :icon="addingMannequin ? undefined : IconUserPlus" :loading="addingMannequin" text circle size="small" :aria-label="translate('添加人偶')" :disabled="!ready || addingMannequin || exportingVideo || !!exportingImage || tasks.some(isDirectorGenerationPending)" @click="emit('addMannequin')" />
          </el-tooltip>
        </template>
      </sceneOutline>
      </div>
      <section class="stagePanel" :aria-label="translate('场景与镜头')">
        <div ref="viewport" class="viewport" :class="{ stageMode: viewMode === 'stage' }" :style="{ '--sceneAspect': sceneAspect }">
          <canvas
            :key="canvasKey"
            ref="canvas"
            class="sceneCanvas"
            :class="{ playing }"
            tabindex="0"
            :aria-label="translate('导演台场景')"
            @pointerdown="rememberPointer"
            @click.left="clickStage"
            @mousedown.right.prevent="viewMode === 'camera' && captureCameraAction()"
            @contextmenu.prevent
            @keydown="handleKeyDown"
            @keyup="handleKeyUp"
            @blur="exitControl"
            @wheel.prevent.stop="changeFocalLength" />
          <div v-if="captureFlash" :key="captureFlash" class="captureFlash" aria-hidden="true" @animationend="captureFlash = 0" />
          <div class="stageToolbar">
          <div class="viewTools"><div class="viewModes"><button :title="translate('导演视角')" :class="{ active: viewMode === 'stage' }" :disabled="!ready || playing" @click="setViewMode('stage')"><icon-cube :size="14" />{{ translate('导演视角') }}</button><button :title="translate('机位视角')" :class="{ active: viewMode === 'camera' }" :disabled="!ready || playing" @click="setViewMode('camera')"><icon-camera :size="14" />{{ translate('机位视角') }}</button></div><div class="transformModes" v-if="viewMode === 'stage'"><button v-for="tool in transformTools" :key="tool.mode" :class="{ active: transformMode === tool.mode }" :disabled="editLocked || !!selectedCamera && tool.mode === 'scale'" :title="translate(tool.name)" :aria-label="translate(tool.name)" @click="setTransformMode(tool.mode)"><component :is="tool.icon" :size="16" /></button><button :disabled="!ready" :title="translate('聚焦物体')" :aria-label="translate('聚焦物体')" @click="focusObject(selectedCamera?.id ?? selectedObjectId)"><icon-focus-2 :size="16" /></button><button :disabled="!ready" :aria-pressed="framedTarget === ''" :title="translate('总览场景 · Shift+F')" :aria-label="translate('总览场景')" @click="focusObject('')"><icon-maximize :size="16" /></button></div></div>
            <div class="framingTools">
            <div class="compactViewControls"><select :value="aspectRatio" :aria-label="translate('画面比例')" @change="aspectRatio=($event.target as HTMLSelectElement).value"><option v-for="ratio in aspectRatios" :key="ratio" :value="ratio">{{ ratio }}</option></select><select :aria-label="translate('视角方向')" :disabled="!ready" @change="axisView(($event.target as HTMLSelectElement).value);($event.target as HTMLSelectElement).value=''" value=""><option disabled value="">{{ translate('视角方向') }}</option><option value="front">{{ translate('正视') }}</option><option value="side">{{ translate('侧视') }}</option><option value="top">{{ translate('俯视') }}</option></select></div>
          <div class="viewAxis" v-if="viewMode === 'stage'"><button v-for="view in ['front', 'side', 'top']" :key="view" :disabled="!ready" @click="axisView(view)">{{ translate(view === 'front' ? '正视' : view === 'side' ? '侧视' : '俯视') }}</button></div>
            <select class="lensSelect" :value="Math.round(displayCameraAnchor ? cameraFocalLength(displayCameraAnchor, sceneAspect) : focalLength)" :aria-label="translate('焦距')" :disabled="!ready||editLocked||!!cameraRecordingState.error" @change="setLens(Number(($event.target as HTMLSelectElement).value))"><option v-if="![18,24,35,50,85,110].includes(Math.round(displayCameraAnchor ? cameraFocalLength(displayCameraAnchor, sceneAspect) : focalLength))" :value="Math.round(displayCameraAnchor ? cameraFocalLength(displayCameraAnchor, sceneAspect) : focalLength)">{{ (displayCameraAnchor ? cameraFocalLength(displayCameraAnchor, sceneAspect) : focalLength).toFixed(0) }} mm</option><option v-for="lens in [18,24,35,50,85,110]" :key="lens" :value="lens">{{ lens }} mm</option></select>
            </div>
          </div>
          <div v-if="compositionGrid && viewMode === 'camera'" class="compositionGrid" aria-hidden="true"><i/><i/><b/><b/></div>
          <div v-if="sceneSettings.labelsVisible && viewMode === 'stage'" class="actorLabels"><span v-for="label in actorLabels" :key="label.id" :style="{ left: label.x + '%', top: label.y + '%' }">{{ label.name }}</span></div>


          <div v-if="!ready || documentUnavailable || documentLoading" class="stageLoading">
            <icon-loader-2 v-if="!loadError && !documentUnavailable" class="loadingIcon" :size="24" />
            <span>{{ documentUnavailable ? translate('请重新打开导演台，确认最新场景') : loadError || translate('正在载入场景') }}</span>
          </div>
          <div class="stageFooter">
          <div class="viewportInfo">
            <span>{{ playing ? translate("播放中") : controlling ? translate('WASD 移动 · 空格上升 · Shift 下降 · 滚轮调焦 · 右键记录 · 左键 / Esc 退出取景') : viewMode === "stage" ? translate("拖动旋转 · 右键平移 · 滚轮缩放") : translate("点击画布取景") }}</span>
          </div>
          <div class="bottomControlRow">
            <div class="bottomTools">
              <button :title="translate('导演视角')" :aria-label="translate('导演视角')" @click="setViewMode('stage')"><icon-arrows-move :size="17"/></button>
              <button :disabled="processing" :title="translate(recordingCameraActive?'录入此刻镜头':'记录机位')" :aria-label="translate(recordingCameraActive?'录入此刻镜头':'记录机位')" @click="timelineOpen = true; captureCameraAction()"><icon-camera-plus :size="17"/></button>
              <button :class="{ active: timelineOpen }" :title="translate('动画时间轴')" :aria-label="translate('动画时间轴')" @click="timelineOpen = !timelineOpen"><icon-movie :size="17"/></button>
            </div>
            <div class="stageComposer" @focusin="rightTab = 'assistant'">
      <directorPanel :historyTarget="historyHost" :historyVisible="rightTab === 'assistant'"
        v-model:mode="aiMode"
        v-model:prompt="prompt"
        v-model:model="model"
        :result="result"
        :referenceCount="anchors.length" :mediaReferenceCount="mediaReferenceCount"
        :managePlan="managePlan" :plans="plans"
        :selectedPlanId="selectedPlanId"
        :tasks="tasks"
        :initializing="addingMannequin || !ready || exportingVideo || !!exportingImage || tasks.some(isDirectorGenerationPending)"
        @addReference="emit('addReference')" @selectPlan="selectPlan"
        :selectedObjectName="selectedName"
        :models="models"
        :modelsLoading="modelsLoading"
        @loadModels="emit('loadModels')"
        @send="emit('generate')"
        @cancelTask="emit('cancelTask', $event)"
        @dismissTask="emit('dismissTask', $event)"
        @editInstruction="emit('editInstruction', $event)">
        <template #input><slot name="input" /></template><template #references><slot name="references" /></template>
      </directorPanel>
            </div>
          </div>
          </div>
        </div>
        <div v-show="timelineOpen" class="keyframeDock">
          <animationTimeline ref="timelineView" :playing="playing" v-model:recording="recordKeyframes" :canRecord="canRecordTarget" :recordKind="canRecordCamera?'camera':'actor'" :plan="result" :scene="scene" :time="currentTime" :selectedObjectId="selectedObjectId" :disabled="editLocked" :apply="editTimeline" :planId="selectedPlanId" :managePlan="managePlan" @seek="seekTime" @selectFrame="selectTimelineFrame">
            <template #lead>
              <el-button class="iconButton" :icon="playing ? IconPlayerPause : IconPlayerPlay" :disabled="!ready || !result" text circle :aria-label="playing ? translate('暂停影片') : translate('播放影片')" @click="togglePlayback" />
              <span class="timeLabel">{{ formatTime(currentTime) }} / {{ formatTime(result?.duration ?? 0) }}</span>
            </template>
            <template #trail>
              <el-button class="iconButton" :icon="IconGrid3x3" :class="{ active: compositionGrid }" :aria-pressed="compositionGrid" text circle :title="translate('构图辅助线')" :aria-label="translate('构图辅助线')" @click="compositionGrid = !compositionGrid" />
              <el-button :icon="IconCameraPlus" :disabled="processing" :title="translate(recordingCameraActive?'录入此刻镜头':'记录机位')" :aria-label="translate(recordingCameraActive?'录入此刻镜头':'记录机位')" @click="captureCameraAction">{{ translate(recordingCameraActive?'录入此刻镜头':'记录机位') }}</el-button>
              <el-button class="exportVideoButton" type="primary" :disabled="processing || !result" :loading="exportingVideo" :title="exportingVideo ? translate('导出视频 {0}%', { 0: exportProgress ?? 0 }) : translate('导出视频节点')" :aria-label="translate('导出视频节点')" @click="emit('exportVideo', sceneAspect, recordingCameraActive ? undefined : selectedCamera)">
                {{ exportingVideo ? translate('导出视频 {0}%', { 0: exportProgress ?? 0 }) : translate('导出视频节点') }}
              </el-button>
            </template>
          </animationTimeline>
          <div class="referenceHeader">
            <span>
              {{ translate('机位关键帧') }}
              <small>{{ anchors.length }}</small>
            </span>
            <div class="motionActions"><small v-if="anchors.length > 1">{{ translate('拖动调整顺序') }}</small><el-input-number v-number-a11y v-model="motionDuration" :min="0.2" :max="300" :step="1" :precision="1" :controls="false" size="small" :aria-label="translate('运镜总时长')" /><span>{{ translate('秒') }}</span><select v-model="motionEasing" :aria-label="translate('运镜过渡')"><option value="smooth">{{ translate('平滑') }}</option><option value="linear">{{ translate('匀速') }}</option><option value="cut">{{ translate('切镜') }}</option></select><el-button size="small" :disabled="editLocked || anchors.length < 2 || !motionDuration" @click="emit('createMotion', motionDuration, motionEasing)">{{ translate('创建运镜') }}</el-button></div>
          </div>
          <vue-draggable v-model="anchors" :disabled="processing" class="referenceList" direction="horizontal" handle=".referenceImage" :animation="150">
            <div v-for="(anchor, index) in anchors" :key="anchor.id" class="referenceItem" :class="{ selected: activeAnchorId === anchor.id }">
              <button class="referenceImage" type="button" :disabled="!ready" :aria-label="translate('查看机位 {0}', { 0: index + 1 })" @click="restoreAnchor(anchor)">
                <img v-if="anchorPreviews[anchor.id]" :src="anchorPreviews[anchor.id]" alt="" draggable="false" />
                <icon-camera v-else :size="22" />
                <span>{{ String(index + 1).padStart(2, "0") }}</span>
              </button>
              <el-button class="removeReference" :disabled="processing" :icon="IconX" text circle :aria-label="translate('删除机位 {0}', { 0: index + 1 })" @click="removeAnchor(anchor.id)" />
              <el-button class="exportReference" :icon="IconPhotoPlus" text circle size="small" :title="translate('发送到画布')" :disabled="processing" :loading="exportingImage === anchor.id" :aria-label="translate('发送机位 {0} 截图到画布', { 0: index + 1 })" @click="emit('exportImage', anchor, sceneAspect, anchor.time ?? currentTime)" />
            </div>
            <button class="referenceAdd" type="button" :disabled="processing" :aria-label="translate(recordingCameraActive?'录入此刻镜头':'记录机位')" @click="captureCameraAction"><icon-camera-plus :size="20" /></button>
          </vue-draggable>
        </div>
      </section>

      <aside class="rightWorkspace">
        <div class="panelResizer" role="separator" aria-orientation="vertical" tabindex="0" :aria-label="translate('调整右侧面板宽度')" :aria-valuenow="panelWidth.right" @pointerdown="startPanelResize($event, 'right')" @dblclick="setPanelWidth('right', panelLimits.right[2])" @keydown.left.prevent="setPanelWidth('right', panelWidth.right + 16)" @keydown.right.prevent="setPanelWidth('right', panelWidth.right - 16)" />
        <div class="inspectorTabs rightTabs"><button :class="{ active: rightTab === 'properties' }" @click="rightTab = 'properties'" :aria-label="translate('属性')">{{ selectedName || translate('场景') }}</button><button :class="{ active: rightTab === 'assistant' }" @click="rightTab = 'assistant'">{{ translate('导演助手') }}</button></div>
        <div v-show="rightTab === 'properties'" class="rightProperties">
      <cameraInspector :objects="scene.objectList" :recording="recordingCameraActive" :recordError="cameraRecordingState.error" :resolvedView="resolvedSelectedCamera" @bind="bindAnchor" @focus="selectedCamera && focusObject(selectedCamera.id)" v-if="selectedCamera" :preview="recordingCameraActive?recordingCameraPreview:anchorPreviews[selectedCamera.id]" :anchor="displayCameraAnchor!" :name="anchorName(selectedCamera)" :aspect="sceneAspect" :disabled="editLocked||!!cameraRecordingState.error" @update="updateAnchor" @recordFrame="displayCameraAnchor&&updateAnchor(displayCameraAnchor)" @lookThrough="restoreAnchor(selectedCamera)" @copy="copyAnchor(selectedCamera)" @remove="removeAnchor(selectedCamera.id)" @useCurrentView="replaceAnchorView(selectedCamera)" @snapshot="displayCameraAnchor&&emit('exportImage',displayCameraAnchor,sceneAspect,recordingCameraActive?currentTime:selectedCamera.time??currentTime)" />
      <sceneOutline v-else view="inspector" :animationEditing="recordingActorActive"
        v-model:selectedId="selectedObjectId"
        :objects="inspectorObjects"
        :selectionDisabled="processing"
        :animatedIds="result?.tracks.map(track => track.objectId)"
        :disabled="editLocked"
        @addActor="emit('addMannequin')" @addObjects="emit('addObjects', $event)" @focus="focusObject" @duplicate="emit('duplicateObject', $event)" @ungroup="emit('ungroupAsset', $event)" @remove="emit('removeObject', $event)"
        @preview="previewObject"
        @commit="commitObject">
        <template #scene>
          <div class="environmentInspector"><h3>{{ translate('场景设置') }}</h3>
              <div ref="settingsOverlayHost"><div class="sceneSettingsPanel" :inert="processing">
                <input ref="panoramaInput" type="file" accept="image/png,image/jpeg,image/webp" hidden @change="choosePanorama" />
                <div class="settingRow"><span>{{ translate('全景背景') }}</span><el-button size="small" :disabled="editLocked" @click="panoramaInput?.click()">{{ panoramaName ? translate('替换') : translate('上传') }}</el-button></div>
                <template v-if="panoramaName"><div class="settingRow"><span>{{ translate('水平旋转') }}</span><el-input-number v-number-a11y :modelValue="sceneSettings.panoramaRotation ?? 0" :min="-360" :max="360" :step="15" :controls="false" @change="$event != null && (sceneSettings = { ...sceneSettings, panoramaRotation: $event })" /></div><el-button text size="small" @click="emit('clearPanorama')">{{ translate('移除全景背景') }}</el-button></template>
                <div class="settingRow"><span>{{ translate('天空颜色') }}</span><colorField :modelValue="sceneBackground(scene, sceneSettings)" :label="translate('天空颜色')" @change="sceneSettings = { ...sceneSettings, backgroundColor: $event, skyVisible: false }" /></div>
                <div class="settingRow"><span>{{ translate('地面') }}</span><el-switch :modelValue="sceneSettings.groundVisible ?? false" @change="sceneSettings = { ...sceneSettings, groundVisible: $event === true }" /></div>
                <template v-if="sceneSettings.groundVisible"><div class="settingRow"><span>{{ translate('地面颜色') }}</span><colorField :modelValue="stageGroundColor(sceneSettings)" :label="translate('地面颜色')" @change="sceneSettings = { ...sceneSettings, groundColor: $event }" /></div><div class="settingRow"><span>{{ translate('地面高度') }}</span><el-input-number v-number-a11y :modelValue="sceneSettings.groundHeight ?? -0.015" :step="0.1" :precision="2" :min="-100" :max="100" :controls="false" @change="$event != null && (sceneSettings = { ...sceneSettings, groundHeight: $event })" /></div><div class="settingRow sliderRow"><span>{{ translate('透明度') }}</span><el-slider :modelValue="groundOpacityDraft ?? sceneSettings.groundOpacity ?? 1" :min="0" :max="1" :step="0.05" :showTooltip="false" :aria-label="translate('地面透明度')" @update:modelValue="previewGroundOpacity(Number($event))" @change="sceneSettings = { ...sceneSettings, groundOpacity: Number($event) }; groundOpacityDraft = undefined" /><el-input-number v-number-a11y :modelValue="sceneSettings.groundOpacity ?? 1" :min="0" :max="1" :step="0.05" :precision="2" :controls="false" :aria-label="translate('地面透明度')" @change="$event != null && (sceneSettings = { ...sceneSettings, groundOpacity: $event })" /></div></template>
                <div class="settingRow"><span>{{ translate('角色标签') }}</span><el-switch :modelValue="sceneSettings.labelsVisible ?? false" @change="sceneSettings = { ...sceneSettings, labelsVisible: $event === true }" /></div>
                <div class="settingRow"><span>{{ translate('网格吸附') }}</span><el-switch :modelValue="sceneSettings.snapToGrid ?? false" @change="sceneSettings = { ...sceneSettings, snapToGrid: $event === true }" /></div>
                <div class="settingRow">
                  <span>{{ translate('网格') }}</span>
                  <el-switch :modelValue="sceneSettings.gridVisible" :aria-label="translate('显示网格')" @change="sceneSettings = { ...sceneSettings, gridVisible: $event === true }" />
                </div>
                <div class="settingRow">
                  <span>{{ translate('天空盒') }}</span>
                  <el-switch :modelValue="sceneSettings.skyVisible" :aria-label="translate('显示天空盒')" @change="sceneSettings = { ...sceneSettings, skyVisible: $event === true }" />
                </div>
              </div></div>
          <h3>{{ translate('光照设置') }}</h3>
              <div ref="lightingOverlayHost"><div class="lightingPanel" :inert="processing">
                <div class="lightPresets"><button v-for="preset in lightingPresets" :key="preset.name" :style="{ '--lightColor': preset.color }" @click="updateLighting({ ...preset.settings, globalEnabled: true, sunEnabled: true })"><i/>{{ translate(preset.name) }}</button></div>
                <div class="lightingRow">
                  <span>{{ translate('全局光照') }} <small>{{ translate('无阴影') }}</small></span>
                  <div class="lightingInputs">
                    <el-switch :modelValue="lighting.globalEnabled" :aria-label="translate('全局光照')" @change="updateLighting({ globalEnabled: $event === true })" />
                    <el-input-number v-number-a11y :modelValue="lighting.globalIntensity" :min="0" :max="100" :step="0.1" :precision="2" :controls="false" :aria-label="translate('全局光照强度')" @update:modelValue="$event != null && updateLighting({ globalIntensity: $event })" />
                  </div>
                </div>
                <div class="lightingRow">
                  <span>{{ translate('太阳光') }} <small>{{ translate('有阴影') }}</small></span>
                  <el-switch :modelValue="lighting.sunEnabled" :aria-label="translate('太阳光')" @change="updateLighting({ sunEnabled: $event === true })" />
                </div>
                <template v-if="lighting.sunEnabled">
                  <lightDirection v-model:azimuth="lightingDraft.azimuth" v-model:elevation="lightingDraft.elevation" :referenceAzimuth="lightingReference" @change="updateLighting" />
                  <div class="lightingRow">
                    <div class="lightingInputs">
                      <span>{{ translate('颜色') }}</span>
                      <colorField :modelValue="lighting.color" :label="translate('太阳光颜色')" @change="updateLighting({ color: $event })" />
                    </div>
                    <div class="lightingInputs">
                      <span>{{ translate('强度') }}</span>
                      <el-input-number v-number-a11y :modelValue="lighting.intensity" :min="0" :max="100" :step="0.1" :precision="2" :controls="false" :aria-label="translate('太阳光强度')" @update:modelValue="$event != null && updateLighting({ intensity: $event })" />
                    </div>
                  </div>
                </template>
              </div></div>
          </div>
        </template>
      </sceneOutline>
        </div>
        <div v-show="rightTab === 'assistant'" ref="historyHost" class="assistantHistoryHost" />
      </aside>
    </div>
    <directorTour v-if="ready && visible" :root="workspace" />
  </el-dialog>
</template>

<script setup lang="ts">
import './directorTheme.css';
import { provideNodePreviewVisibility } from '../../scaffold/useNodePreviewReady';
import { sceneBackground, stageGroundColor, applySceneSettings, createStage } from './stageRuntime';
import { vNumberA11y } from './numberInputA11y';
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { ElButton, ElDialog, ElMessage, ElSwitch, ElInputNumber, ElTooltip } from "element-plus";
import { IconCube3dSphere, IconCamera, IconCameraPlus, IconLoader2, IconPlayerPause, IconPlayerPlay, IconX, IconMovie, IconPhotoPlus, IconSun, IconSettings, IconUserPlus, IconCube, IconArrowsMove, IconRotate, IconArrowsDiagonal, IconFocus2, IconMaximize, IconGrid3x3, IconArrowBackUp, IconArrowForwardUp, IconStack2, IconAspectRatio } from "@tabler/icons-vue";
import cameraInspector from './cameraInspector.vue';
import { resolveCameraView, type CameraBinding } from './cameraTracking';
import animationTimeline from './animationTimeline.vue';
import { planDisplayNames } from './planManagement';
import { snapshotStage } from './stageSnapshot';
import {sampledCameraView,cameraViewIntoBindings} from './cameraRecording';
import { frameStageBounds, stageScreenBounds, type StageFrameArea } from './stageFraming';
import { sampledObjectPose, type TimelineRequest, type TimelineTarget } from './timeline';
import { cameraFocalLength, cameraFov, cameraViewFromTransform, createCameraRig } from './cameraRig';
import directorPanel from "./directorPanel.vue";
import sceneOutline from "./sceneOutline.vue";
import directorTour from "./directorTour.vue";
import stageAddPanel from "./stageAddPanel.vue";
import { aspectRatios, shotPresets, shotPresetView } from "./cameraPresets";
import type { BodyType } from "./mannequin";
import lightDirection from "./lightDirection.vue";
import colorField from "./colorField.vue";
import { VueDraggable } from "vue-draggable-plus";
import { assemblyObjectPatch, editStageAsset, stageAssemblies } from './stageGroups';
import { Box3, Box3Helper, Group, Mesh, MeshBasicMaterial, Quaternion, Raycaster, Vector2, Vector3 } from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { TransformControls } from "three/examples/jsm/controls/TransformControls.js";
import { lightingPresets } from "./stageLibrary";
import { mannequinJoints } from "./mannequin";
import { PointerLockControls } from "three/examples/jsm/controls/PointerLockControls.js";
import { getObjectByThreeJsonId, type SceneRuntime } from "threejson/core";
import { nodeTools, z, type NodeAiModel } from "@miaoimg/nodes-scaffold/runtime";
import { applyLighting, cameraViewSchema, type CameraView, type ObjectPatch, captureCamera, disposeStage, type LightingSettings, type SceneDocument, type SceneSettings } from "./scene";
import { anchorSchema, applyCamera, prepareMotion, sampleMotion, type CameraAnchor } from "./motion";
import type { DirectorMode } from "./agentTools";
import { isDirectorGenerationPending, prepareSceneAnimation, resetScenePose, type DirectorPlan, type DirectorPlanItem, type DirectorGeneration } from "./sceneAnimation";
import { translate } from "@miaoimg/i18n/vue";

const props = defineProps<{
  scene: SceneDocument;
  documentUnavailable?: boolean;
  documentLoading?: boolean;
  result?: DirectorPlan;
  plans: DirectorPlanItem[];
  selectedPlanId: string;
  tasks: DirectorGeneration[];
  models: NodeAiModel[];
  modelsLoading: boolean;
  addingMannequin: boolean;
  exportingVideo: boolean;
  exportingImage: string;
  exportProgress?: number;
  panoramaName?: string;
  mediaReferenceCount:number;
  managePlan:(request:import('./planManagement').PlanManagementRequest)=>Promise<boolean>;
  editTimeline:(request:TimelineRequest)=>Promise<boolean>;
  canUndo?: boolean;
  canRedo?: boolean;
}>();
provideNodePreviewVisibility(true);
const planTitle=computed(()=>planDisplayNames(props.plans).get(props.selectedPlanId)??props.result?.name);
const emit = defineEmits<{ addReference:[];editInstruction: [value: string]; selectPlan: [id: string]; generate: []; cancelTask: [id: string]; dismissTask: [id: string]; loadModels: []; close: []; addMannequin: [options?: { bodyType?: BodyType; crowd?: boolean }]; addObjects: [objects: SceneDocument["objectList"]]; removeObject: [id: string]; duplicateObject: [id: string]; ungroupAsset: [id: string]; history: [direction: "undo" | "redo"]; createMotion: [duration: number, easing: "smooth" | "linear" | "cut"]; uploadPanorama: [file: File]; clearPanorama: []; updateObject: [id: string, patch: ObjectPatch]; exportVideo: [aspect: number, camera?: CameraAnchor]; exportImage: [anchor: CameraAnchor, aspect: number, time: number] }>();
const anchors = defineModel<CameraAnchor[]>("anchors", { default: () => [] });
const lighting = defineModel<LightingSettings>("lighting", { required: true });
const sceneSettings = defineModel<SceneSettings>("sceneSettings", { required: true });
const lightingDraft = ref({ ...lighting.value });
const lightingReference = ref(0);
const aiMode = defineModel<DirectorMode>("aiMode", { default: "animation" });
const prompt = defineModel<string>("prompt", { default: "" });
const model = defineModel<string>("model", { default: "" });
const anchorPreviews = ref<Record<string, string>>({});
const workspace = ref<HTMLElement>();
const outlineView = ref<InstanceType<typeof sceneOutline>>();
const historyHost = ref<HTMLElement>(), viewport = ref<HTMLElement>();
const rightTab = ref<'properties' | 'assistant'>('properties'), timelineOpen = ref(false);
const leftPanel = ref<'scene' | 'actors' | 'cameras' | 'ratio'>('scene'), assetsOpen = ref(false);
// Side panels are resizable [min, max, default]; the stage keeps at least 360px and widths persist per viewer.
const panelLimits = { left: [220, 480, 280], right: [260, 560, 280] } as const;
function storedPanelWidth(side: 'left' | 'right') {
  try { const value = Number(localStorage.getItem(`miaoimg.director.${side}Width`)); if (value) return value; } catch { /* storage may be unavailable */ }
  return panelLimits[side][2];
}
const panelWidth = ref({ left: storedPanelWidth('left'), right: storedPanelWidth('right') });
function setPanelWidth(side: 'left' | 'right', value: number) {
  const other = side === 'left' ? panelWidth.value.right : panelWidth.value.left, room = (workspace.value?.clientWidth ?? window.innerWidth) - other - 360;
  const width = Math.round(Math.max(panelLimits[side][0], Math.min(panelLimits[side][1], room, value)));
  panelWidth.value = { ...panelWidth.value, [side]: width };
  try { localStorage.setItem(`miaoimg.director.${side}Width`, String(width)); } catch { /* keep the in-memory width */ }
}
function startPanelResize(event: PointerEvent, side: 'left' | 'right') {
  const handle = event.currentTarget as HTMLElement, startX = event.clientX, base = panelWidth.value[side];
  handle.setPointerCapture(event.pointerId); handle.classList.add('dragging');
  const move = (next: PointerEvent) => setPanelWidth(side, base + (side === 'left' ? next.clientX - startX : startX - next.clientX));
  const end = () => { handle.classList.remove('dragging'); handle.removeEventListener('pointermove', move); handle.removeEventListener('pointerup', end); handle.removeEventListener('pointercancel', end); };
  handle.addEventListener('pointermove', move); handle.addEventListener('pointerup', end); handle.addEventListener('pointercancel', end);
}
function openLeftPanel(panel: 'scene' | 'actors' | 'cameras' | 'ratio' | 'assets') {
  leftPanel.value = panel === 'assets' ? 'scene' : panel; assetsOpen.value = panel === 'assets';
  if (panel === 'assets') outlineView.value?.showAssets(); else if (panel === 'scene') outlineView.value?.showScene();
}
function showSceneProperties() { outlineView.value?.showScene(); activeAnchorId.value = ''; selectedObjectId.value = ''; rightTab.value = 'properties'; }
const canvas = ref<HTMLCanvasElement>();
const panoramaInput = ref<HTMLInputElement>();
const lightingOverlayHost = ref<HTMLElement>(), settingsOverlayHost = ref<HTMLElement>();
function choosePanorama(event: Event) { const input = event.target as HTMLInputElement; const file = input.files?.[0]; if (file) emit("uploadPanorama", file); input.value = ""; }
const canvasKey = ref(0);
const ready = ref(false);
const loadError = ref('');
const visible = ref(true);
const manualCamera = ref(false);
const controlling = ref(false);
const playing = ref(false);
const aspectRatio = defineModel<string>("aspectRatio", { default: "16:9" });
const sceneAspect = computed(() => {
  const [width, height] = aspectRatio.value.split(":").map(Number);
  return width! / height!;
});
const currentTime = ref(0);
const recordKeyframes=ref(false),gizmoRevision=ref(0),recordBusy=ref(false);
const canRecordActor=computed(()=>props.scene.objectList.some(o=>o.threeJsonId===selectedObjectId.value&&o.objType==='mannequin'));
const canRecordCamera=computed(()=>!!selectedCamera.value),canRecordTarget=computed(()=>canRecordActor.value||canRecordCamera.value);
const recordingActorActive=computed(()=>recordKeyframes.value&&timelineOpen.value&&!!props.result&&canRecordActor.value),recordingCameraActive=computed(()=>recordKeyframes.value&&timelineOpen.value&&!!props.result&&canRecordCamera.value);
const recordingActive=computed(()=>recordingActorActive.value||recordingCameraActive.value);
const recordingCameraPreview=ref('');

const motionDuration = ref(5);
const motionEasing = ref<'smooth' | 'linear' | 'cut'>('smooth');
const selectedObjectId = defineModel<string>("selectedObjectId", { default: "" });
const processing = computed(() => recordBusy.value || !ready.value || !runtimeMatchesDocument() || props.documentUnavailable || props.documentLoading || props.exportingVideo || !!props.exportingImage || props.addingMannequin || props.tasks.some(isDirectorGenerationPending));
const editLocked = computed(() => processing.value || playing.value);
const viewMode = ref<'stage' | 'camera'>('stage');
const compositionGrid = ref(false);
const actorLabels = ref<{ id: string; name: string; x: number; y: number }[]>([]);
const transformMode = ref<'translate' | 'rotate' | 'scale'>('translate');
const transformTools = [{ mode: 'translate', name: '移动物体', icon: IconArrowsMove }, { mode: 'rotate', name: '旋转物体', icon: IconRotate }, { mode: 'scale', name: '缩放物体', icon: IconArrowsDiagonal }] as const;
let orbit: OrbitControls | undefined;
let gizmo: TransformControls | undefined;
let outline: Box3Helper | undefined;
let assemblyProxy: Group | undefined;
const assemblies = computed(() => stageAssemblies(props.scene.objectList));
const selectedName = computed(() => selectedCamera.value ? anchorName(selectedCamera.value) : assemblies.value.find(group => group.id === selectedObjectId.value)?.name ?? props.scene.objectList.find(object => object.threeJsonId === selectedObjectId.value)?.name ?? '');
const timelineView=ref<InstanceType<typeof animationTimeline>>();
const framedTarget=ref<string>();
let stageView: ReturnType<typeof captureCamera> | undefined;
let cameraView: ReturnType<typeof captureCamera> | undefined;
let pointerStart = { x: 0, y: 0 };
let wasDragging = false;
const focalLength = ref(0);
const activeAnchorId = ref("");
const timelineCameraId=crypto.randomUUID();
const isTimelineCamera=computed(()=>!selectedObjectId.value&&activeAnchorId.value===timelineCameraId&&!!props.result);
const selectedCamera = computed<CameraAnchor|undefined>(() => {
 if(selectedObjectId.value)return;
 if(isTimelineCamera.value&&props.result)return{...props.result.cameraFrames[0]!.view,id:timelineCameraId,name:translate('动画镜头'),time:0};
 return anchors.value.find(anchor=>anchor.id===activeAnchorId.value);
});
const cameraRecordingState=computed<{view?:CameraView;error?:string}>(()=>{
 if(!recordingCameraActive.value||!props.result)return{};
 try{return{view:sampledCameraView(props.result,currentTime.value,runtimeMatchesDocument()?runtime?.camera.userData.directorResolveTarget:undefined)}}catch(error){return{error:error instanceof Error?error.message:translate('镜头录帧参数无效，原方案已保留')}};
});
const displayCameraAnchor=computed<CameraAnchor|undefined>(()=>{const a=selectedCamera.value;if(!a)return;return recordingCameraActive.value?{...a,...cameraRecordingState.value.view,time:currentTime.value}:a;});

function stageCameras(){const camera=isTimelineCamera.value&&!cameraRecordingState.value.error?displayCameraAnchor.value:undefined;return camera?[...anchors.value,camera]:anchors.value;}
const cameraRigs = new Map<string, ReturnType<typeof createCameraRig>>();
function anchorName(anchor: CameraAnchor) { return anchor.name || translate('机位 {0}', { 0: anchors.value.findIndex(item => item.id === anchor.id) + 1 }); }
function cameraEntries(query: string) { return anchors.value.map(anchor => ({ anchor, name: anchorName(anchor) })).filter(item => !query.trim() || item.name.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase())); }
function runtimeMatchesDocument(){return !!runtime&&!!loadedScene&&loadedScene.objectList.length===props.scene.objectList.length&&loadedScene.objectList.every((o,i)=>o.threeJsonId===props.scene.objectList[i]?.threeJsonId);}
const resolvedSelectedCamera=computed(()=>{currentTime.value;props.scene;return displayCameraAnchor.value&&runtimeMatchesDocument()&&runtime?resolveCameraView(displayCameraAnchor.value,runtime.camera.userData.directorResolveTarget):undefined;});
function bindAnchor(kind:'follow'|'lookAt',id:string){
  const anchor=displayCameraAnchor.value;if(!anchor||!runtime||editLocked.value)return;
  const view=resolveCameraView(anchor,runtime.camera.userData.directorResolveTarget),tracking={...anchor.camera.tracking};
  if(id){const binding:CameraBinding={objectId:id,point:kind==='follow'?'root':'center',offset:{x:0,y:0,z:0}};if(kind==='follow'){const point=runtime.camera.userData.directorResolveTarget(binding);binding.offset={x:view.camera.position.x-point.x,y:view.camera.position.y-point.y,z:view.camera.position.z-point.z};}tracking[kind]=binding;}else delete tracking[kind];
  updateAnchor({...anchor,camera:{...anchor.camera,position:{...view.camera.position},tracking:Object.keys(tracking).length?tracking:undefined},controls:view.controls});
}
function refreshTrackedCameras(){
  if(!runtime||!runtimeMatchesDocument())return;
  for(const anchor of stageCameras()){const shown=recordingCameraActive.value&&anchor.id===activeAnchorId.value?displayCameraAnchor.value??anchor:anchor;if(shown.camera.tracking||shown!==anchor)cameraRigs.get(anchor.id)?.updatePose(resolveCameraView(shown,runtime.camera.userData.directorResolveTarget));}
  const active=selectedCamera.value;
  if(active&&!cameraRecordingState.value.error&&viewMode.value==='camera'&&manualCamera.value&&!controlling.value)applyCamera(runtime.camera,recordingCameraActive.value?displayCameraAnchor.value??active:active);
}
function syncCameraRigs() {
  if (!runtime || !runtimeMatchesDocument()) return;
  if (gizmo?.object?.userData.cameraAnchorId) gizmo.detach();
  for (const rig of cameraRigs.values()) { runtime.scene.remove(rig.group); rig.dispose(); }
  cameraRigs.clear();
  for (const anchor of stageCameras()) { const shown=recordingCameraActive.value&&anchor.id===activeAnchorId.value?displayCameraAnchor.value??anchor:anchor;const rig = createCameraRig(resolveCameraView(shown,runtime.camera.userData.directorResolveTarget) as CameraAnchor, sceneAspect.value, selectedCamera.value?.id === anchor.id); rig.group.visible = viewMode.value === 'stage'; runtime.scene.add(rig.group); cameraRigs.set(anchor.id, rig); }
  attachSelection(); runtime.invalidate();
}
let timelineSelectionVersion=0;
async function selectTimelineFrame(selection:{target:TimelineTarget;index:number;time:number}){
 const version=++timelineSelectionVersion;if(processing.value)return;
 if(selection.target.kind!=='camera'){
  if(isTimelineCamera.value){activeAnchorId.value='';recordKeyframes.value=false;manualCamera.value=false;syncCameraRigs();sampleTime();}
  return;
 }
 if(!props.result)return;
 pausePlayback();exitControl();selectedObjectId.value='';
 await nextTick();if(version!==timelineSelectionVersion||disposed||!ready.value||!props.result)return;
 activeAnchorId.value=timelineCameraId;recordKeyframes.value=true;aiMode.value='animation';rightTab.value='properties';seekTime(selection.time);syncCameraRigs();
}
function selectAnchor(id: string) { if (processing.value) return; pausePlayback(); exitControl(); selectedObjectId.value = ''; activeAnchorId.value = id; rightTab.value = 'properties'; if (transformMode.value === 'scale') setTransformMode('translate'); syncCameraRigs(); if (viewMode.value === 'camera') { const anchor = anchors.value.find(anchor => anchor.id === id); if (anchor) restoreAnchor(anchor); } }
function updateAnchor(anchor: CameraAnchor) { if (editLocked.value||cameraRecordingState.value.error) return; const parsed = anchorSchema.parse(anchor);if(recordingCameraActive.value){void recordCameraView({camera:parsed.camera,controls:parsed.controls});return;} anchors.value = anchors.value.map(item => item.id === parsed.id ? parsed : item); if (viewMode.value === 'camera' && activeAnchorId.value === parsed.id && runtime) { applyCamera(runtime.camera, parsed); cameraView = parsed; resizeEditor(); } }
function offsetTracking(tracking:CameraView['camera']['tracking'],x:number){if(!tracking)return;return Object.fromEntries(Object.entries(tracking).map(([kind,b])=>[kind,b?{...b,offset:{...b.offset,x:b.offset.x+x}}:b]));}
function copyAnchor(anchor: CameraAnchor) { if(recordingCameraActive.value){ElMessage.info(translate('请先关闭镜头录帧，再复制基础机位'));return;} if (editLocked.value || anchors.value.length >= 100) return; const offset = { x: .5, y: 0, z: 0 }; const copy = anchorSchema.parse({ ...anchor, id: crypto.randomUUID(), name: (anchorName(anchor).slice(0,90) + ' · ' + translate('副本')).slice(0,100), camera: { ...anchor.camera, tracking: offsetTracking(anchor.camera.tracking,offset.x), position: { x: anchor.camera.position.x + offset.x, y: anchor.camera.position.y, z: anchor.camera.position.z } }, controls: { target: { x: anchor.controls.target.x + offset.x, y: anchor.controls.target.y, z: anchor.controls.target.z } } }); anchors.value = [...anchors.value, copy]; selectAnchor(copy.id); }
function replaceAnchorView(anchor: CameraAnchor) { if (!runtime || editLocked.value) return;const template=recordingCameraActive.value?displayCameraAnchor.value??anchor:anchor;updateAnchor({ ...template, ...cameraViewIntoBindings(captureCamera(runtime),template,runtime.camera.userData.directorResolveTarget) }); }
watch([anchors, sceneAspect], () => {
  const active=anchors.value.find(a=>a.id===activeAnchorId.value);
  if(runtime&&runtimeMatchesDocument()&&viewMode.value==='camera'&&active){applyCamera(runtime.camera,active);cameraView=active;resizeEditor();}
  syncCameraRigs(); if (ready.value) refreshThumbnails();
}, { deep: true });
watch(activeAnchorId, syncCameraRigs);
const captureFlash = ref(0);
const pressedKeys = new Set<string>();
const moveKeys = new Set(["KeyW", "KeyA", "KeyS", "KeyD", "Space", "ShiftLeft", "ShiftRight"]);
const focalSteps = [...Array.from({ length: 30 }, (_, index) => index + 6), 40, 45, 50, 55, 60, 65, 70, 80, 90, 100, 110];
const movement = new Vector3();
let runtime: SceneRuntime | undefined;
let loadedScene: SceneDocument | undefined;
let controls: PointerLockControls | undefined;
let requestingControl = false;
let scenePlayer: ReturnType<typeof prepareSceneAnimation> | undefined;
let cameraFrames: ReturnType<typeof prepareMotion> | undefined;
let previousFrame = 0;
let loadVersion = 0;
let disposed = false;
let previewPlanId = "";

function handleEditorShortcut(event: KeyboardEvent) {
  const target = event.target as HTMLElement;
  if (target.closest('input, textarea, [contenteditable=true], .el-slider, .el-select, select') || event.isComposing || controlling.value || editLocked.value) return;
  if(target.closest('.animationTimeline,.directorPanel,.cameraInspector,.environmentInspector,.objectProperties')&&!event.metaKey&&!event.ctrlKey)return;
  if ((event.metaKey || event.ctrlKey) && event.code === 'KeyZ') { event.preventDefault(); event.stopPropagation(); emit('history', event.shiftKey ? 'redo' : 'undo'); }
  else if (viewMode.value === 'stage' && !event.metaKey && !event.ctrlKey && !event.altKey) {
    if (event.code === 'KeyF') { event.preventDefault(); focusObject(event.shiftKey?'':selectedCamera.value?.id ?? selectedObjectId.value); }
    if (event.code === 'KeyW') setTransformMode('translate');
    if (event.code === 'KeyE') setTransformMode('rotate');
    if (event.code === 'KeyR') setTransformMode('scale');
    if ((event.code === 'Delete' || event.code === 'Backspace') && selectedCamera.value) { event.preventDefault(); event.stopPropagation(); removeAnchor(selectedCamera.value.id); return; }
    if ((event.code === 'Delete' || event.code === 'Backspace') && selectedObjectId.value) { event.preventDefault(); event.stopPropagation(); emit('removeObject', selectedObjectId.value); }
  }
}
function rememberPointer(event: PointerEvent) { pointerStart = { x: event.clientX, y: event.clientY }; wasDragging = false; }
function clickStage(event: MouseEvent) {
  if (viewMode.value === 'camera') return void toggleControl();
  if (!runtime || editLocked.value || wasDragging || Math.hypot(event.clientX - pointerStart.x, event.clientY - pointerStart.y) > 4 || gizmo?.axis) return;
  const rect = canvas.value!.getBoundingClientRect();
  const ray = new Raycaster();
  ray.setFromCamera(new Vector2((event.clientX - rect.left) / rect.width * 2 - 1, 1 - (event.clientY - rect.top) / rect.height * 2), runtime.camera);
  const objects = props.scene.objectList.map(o => getObjectByThreeJsonId(o.threeJsonId, runtime!.scene)).filter(Boolean);
  const hit = ray.intersectObjects([...objects, ...[...cameraRigs.values()].map(rig => rig.group)], true).find(hit => hit.object instanceof Mesh);
  let cameraPart = hit?.object;
  while (cameraPart) { if (cameraPart.userData.cameraAnchorId) { selectAnchor(cameraPart.userData.cameraAnchorId); return; } cameraPart = cameraPart.parent ?? undefined; }
  let part = hit?.object;
  activeAnchorId.value = ''; selectedObjectId.value = '';
  while (part) {
    const match = props.scene.objectList.find(o => getObjectByThreeJsonId(o.threeJsonId, runtime!.scene) === part);
    if (match) { activeAnchorId.value = ''; selectedObjectId.value = event.altKey ? match.threeJsonId : match.assembly?.id ?? match.threeJsonId; break; }
    part = part.parent ?? undefined;
  }
}
function setViewMode(mode: 'stage' | 'camera') {
  if (!runtime || mode === viewMode.value) return;
  framedTarget.value=undefined;
  if (viewMode.value === 'stage') stageView = captureCamera(runtime); else cameraView = captureCamera(runtime);
  const nextView = mode === 'stage' ? stageView : displayCameraAnchor.value ?? cameraView;
  if (nextView) applyCamera(runtime.camera, nextView);
  exitControl(); pausePlayback(); viewMode.value = mode; manualCamera.value = true;
  if (orbit) { orbit.enabled = mode === 'stage'; orbit.target.copy(runtime!.camera.position).addScaledVector(runtime!.camera.getWorldDirection(new Vector3()), Math.max(2, orbit.target.distanceTo(runtime!.camera.position))); orbit.update(); }
  resizeEditor(); for (const rig of cameraRigs.values()) rig.group.visible = mode === 'stage'; attachSelection(); runtime?.invalidate();
}
function resizeEditor() {
  if (!runtime || !viewport.value) return;
  const width = viewport.value.clientWidth, height = viewport.value.clientHeight;
  if (!width || !height) return;
  const aspect = viewMode.value === 'stage' ? width / height : sceneAspect.value;
  const renderWidth = Math.max(2, Math.round(Math.min(1440, width, height * aspect))), renderHeight = Math.max(2, Math.round(renderWidth / aspect));
  runtime.renderer.setSize(renderWidth, renderHeight, false); runtime.camera.aspect = aspect; runtime.camera.updateProjectionMatrix(); focalLength.value = runtime.camera.getFocalLength(); runtime.invalidate();
  if(ready.value&&viewMode.value==='stage'&&framedTarget.value!==undefined)reframeTarget(framedTarget.value);
}
watch(viewport, (element, _previous, cleanup) => { if (!element) return; const observer = new ResizeObserver(resizeEditor); observer.observe(element);for(const hud of element.querySelectorAll('.stageToolbar,.stageFooter'))observer.observe(hud); cleanup(() => observer.disconnect()); });
watch(sceneAspect, resizeEditor);
function setTransformMode(mode: 'translate' | 'rotate' | 'scale') { if (selectedCamera.value && mode === 'scale') return; transformMode.value = mode; gizmo?.setMode(mode); }
function selectionBounds(id: string) {
  const bounds = new Box3();
  if (!runtime) return bounds;
  runtime.scene.updateMatrixWorld(true);
  const cameraRig = cameraRigs.get(id); if (cameraRig) return bounds.setFromObject(cameraRig.body);
  const group = assemblies.value.find(group => group.id === id);
  for (const objectId of group?.objectIds ?? [id]) { const object = getObjectByThreeJsonId(objectId, runtime.scene); if (object) bounds.expandByObject(object); }
  return bounds;
}
function updateSelectionOutline() { if (outline) { outline.box.copy(selectionBounds(selectedCamera.value?.id ?? selectedObjectId.value)); outline.visible = !outline.box.isEmpty(); } }
function attachSelection() {
  if (!runtime || !gizmo) return;
  gizmo.detach();
  if (outline) { runtime.scene.remove(outline); outline.geometry.dispose(); (Array.isArray(outline.material) ? outline.material : [outline.material]).forEach(material => material.dispose()); outline = undefined; }
  if (assemblyProxy) { runtime.scene.remove(assemblyProxy); assemblyProxy = undefined; }
  const group = assemblies.value.find(group => group.id === selectedObjectId.value);
  let object = selectedObjectId.value && getObjectByThreeJsonId(selectedObjectId.value, runtime.scene);
  if (group) {
    assemblyProxy = new Group(); assemblyProxy.name = 'directorAssemblyPivot';
    assemblyProxy.position.set(group.position.x, group.position.y, group.position.z);
    assemblyProxy.rotation.set(group.rotation.rotationX, group.rotation.rotationY, group.rotation.rotationZ); assemblyProxy.scale.setScalar(group.scale);
    runtime.scene.add(assemblyProxy); object = assemblyProxy;
  }
  if (selectedCamera.value && transformMode.value === 'scale') transformMode.value = 'translate';
  if (selectedCamera.value) object = cameraRigs.get(selectedCamera.value.id)?.group;
  if (object && viewMode.value === 'stage' && !editLocked.value&&!cameraRecordingState.value.error) {
    gizmo.attach(object); gizmo.setMode(transformMode.value);
    outline = new Box3Helper(selectionBounds(selectedCamera.value?.id ?? selectedObjectId.value), 0xd8d8dc); runtime.scene.add(outline);
  }
  runtime.invalidate();
}
function transformPatch(): ObjectPatch | undefined {
  const object = gizmo?.object, group = assemblies.value.find(group => group.id === selectedObjectId.value);
  const source = props.scene.objectList.find(o => o.threeJsonId === selectedObjectId.value) ?? props.scene.objectList.find(o => o.assembly?.id === selectedObjectId.value);
  if (!object || !source) return;
  if (group && transformMode.value === 'scale') {
    const axis = gizmo?.axis?.includes('X') ? 'x' : gizmo?.axis?.includes('Y') ? 'y' : 'z';
    object.scale.setScalar(Math.min(100, Math.max(0.01, Math.abs(object.scale[axis]))));
  }
  return { name: group?.name ?? source.name ?? '', position: { x: object.position.x, y: object.position.y, z: object.position.z }, rotation: { rotationX: object.rotation.x, rotationY: object.rotation.y, rotationZ: object.rotation.z }, scale: { scaleX: Math.max(0.01, object.scale.x), scaleY: Math.max(0.01, object.scale.y), scaleZ: Math.max(0.01, object.scale.z) }, color: source.material.color };
}
function commitTransform() { if (selectedCamera.value && gizmo?.object && !editLocked.value && runtime) {
  const anchor=displayCameraAnchor.value!,view=resolveCameraView(anchor,runtime.camera.userData.directorResolveTarget);
  const next=cameraViewFromTransform({...anchor,...view},gizmo.object.position,gizmo.object.quaternion),tracking=JSON.parse(JSON.stringify(anchor.camera.tracking??{}));
  for(const kind of ['follow','lookAt'] as const){const binding=tracking[kind] as CameraBinding|undefined;if(!binding||kind==='lookAt'&&transformMode.value!=='rotate')continue;const point=runtime.camera.userData.directorResolveTarget({...binding,offset:{x:0,y:0,z:0}});const desired=kind==='follow'?next.camera.position:next.controls.target;binding.offset={x:desired.x-point.x,y:desired.y-point.y,z:desired.z-point.z};}
  updateAnchor({...anchor,...next,camera:{...next.camera,tracking:Object.keys(tracking).length?tracking:undefined}});return;
} const patch = transformPatch(); if (patch && !editLocked.value) void commitObject(selectedObjectId.value,patch); }
function contentBounds() {
  const bounds=new Box3();if(!runtime)return bounds;runtime.scene.updateMatrixWorld(true);
  for(const source of props.scene.objectList){const object=getObjectByThreeJsonId(source.threeJsonId,runtime.scene);if(object){const item=new Box3().setFromObject(object);reserveLabelSpace(item,source.objType);bounds.union(item);bounds.expandByPoint(object.getWorldPosition(new Vector3()));}}
  return bounds;
}
function reserveLabelSpace(bounds:Box3,type?:string){
  if(type==='mannequin'&&sceneSettings.value.labelsVisible&&!bounds.isEmpty()){const top=bounds.getCenter(new Vector3());top.y=bounds.max.y+.26;bounds.expandByPoint(top);}
}
function frameArea():StageFrameArea|undefined {
  const rect=viewport.value?.getBoundingClientRect();if(!rect?.width||!rect.height)return;
  const toolbar=viewport.value?.querySelector('.stageToolbar')?.getBoundingClientRect(),footer=viewport.value?.querySelector('.stageFooter')?.getBoundingClientRect();
  const top=Math.max(16,(toolbar?.bottom??rect.top)-rect.top+12),bottom=Math.min(rect.height-16,(footer?.top??rect.bottom)-rect.top-24);
  if(bottom<=top||rect.width<=32)return;
  return{width:rect.width,height:rect.height,left:16,right:rect.width-16,top,bottom};
}
function frameTargetBounds(id:string){
  const bounds=id?selectionBounds(id):contentBounds();
  const target=id&&runtime&&getObjectByThreeJsonId(id,runtime.scene);if(target){reserveLabelSpace(bounds,props.scene.objectList.find(o=>o.threeJsonId===id)?.objType);bounds.expandByPoint(target.getWorldPosition(new Vector3()));}
  return bounds;
}
function reframeTarget(id:string){
  const area=frameArea();if(!runtime||!orbit||!area)return;
  const fit=frameStageBounds(runtime.camera,frameTargetBounds(id),runtime.camera.position.clone().sub(orbit.target),area);
  runtime.camera.position.copy(fit.position);orbit.target.copy(fit.target);runtime.camera.lookAt(fit.target);orbit.update();updateLabels();runtime.invalidate();
}
function focusObject(id:string){
  if(!runtime||!orbit)return;pausePlayback();exitControl();setViewMode('stage');manualCamera.value=true;
  framedTarget.value=id;reframeTarget(id);
}
function framingContext(){
  const area=frameArea();if(!runtime||!runtimeMatchesDocument()||viewMode.value!=='stage'||!area)return null;
  return{target:framedTarget.value??null,safeArea:area,content:stageScreenBounds(runtime.camera,contentBounds(),area.width,area.height),selection:stageScreenBounds(runtime.camera,frameTargetBounds(selectedCamera.value?.id??selectedObjectId.value),area.width,area.height)};
}
function axisView(view: string) {
  if (!runtime || !orbit) return;
  setViewMode('stage'); manualCamera.value = true;
  const distance = Math.max(3, runtime.camera.position.distanceTo(orbit.target));
  const offset = view === 'top' ? new Vector3(0, distance, 0.001) : view === 'side' ? new Vector3(distance, 0, 0) : new Vector3(0, 0, distance);
  runtime.camera.position.copy(orbit.target).add(offset); runtime.camera.lookAt(orbit.target); orbit.update();if(framedTarget.value!==undefined)reframeTarget(framedTarget.value); updateLabels(); runtime.invalidate();
}
function updateLabels() {
  if (!runtime || !sceneSettings.value.labelsVisible) { actorLabels.value = []; return; }
  runtime.camera.updateMatrixWorld();
  actorLabels.value = props.scene.objectList.filter(o => o.objType === 'mannequin').flatMap(o => {
    const object = getObjectByThreeJsonId(o.threeJsonId, runtime!.scene);
    if (!object) return [];
    const point = new Box3().setFromObject(object).getCenter(new Vector3());
    point.y = new Box3().setFromObject(object).max.y + 0.16;
    point.project(runtime!.camera);
    return point.z > -1 && point.z < 1 && Math.abs(point.x) < 1 && Math.abs(point.y) < 1 ? [{ id: o.threeJsonId, name: o.name ?? translate('角色'), x: (point.x + 1) * 50, y: (1 - point.y) * 50 }] : [];
  });
}
watch(selectedObjectId, () => { if (selectedObjectId.value) { activeAnchorId.value = ''; syncCameraRigs(); } attachSelection(); if (!props.tasks.some(isDirectorGenerationPending)) rightTab.value = 'properties'; });
watch(() => props.tasks.some(isDirectorGenerationPending), pending => { if (pending) rightTab.value = 'assistant'; });
watch([selectedObjectId, rightTab], () => { if (!selectedObjectId.value && rightTab.value === 'properties') captureLightingReference(); }, { immediate: true });
watch([editLocked,()=>cameraRecordingState.value.error], attachSelection);
watch(() => sceneSettings.value.snapToGrid, enabled => { gizmo?.setTranslationSnap(enabled ? 0.25 : null); gizmo?.setRotationSnap(enabled ? Math.PI / 12 : null); });
watch(() => sceneSettings.value.labelsVisible, updateLabels);

async function selectPlan(id: string) {
  previewPlanId = id;
  emit("selectPlan", id);
  await nextTick();
  previewSelectedPlan();
}

function previewSelectedPlan() {
  if (disposed || !ready.value || !props.result || previewPlanId !== props.selectedPlanId) return;
  previewPlanId = "";
  currentTime.value = 0;
  pausePlayback();
  togglePlayback();
}

async function loadScene() {
  // Dialog transitions may pause while the window is hidden; initialize after
  // the DOM is mounted instead of waiting for the opening animation to finish.
  await nextTick();
  if (!canvas.value) return;
  const version = ++loadVersion;
  const scene = props.scene;
  const previousAnchorId=loadedScene&&loadedScene!==scene?activeAnchorId.value:'';
  ready.value = false;
  loadError.value = '';
  playing.value = false;
  activeAnchorId.value = "";
  exitControl();
  const previousView = runtime && loadedScene?.objectList.length ? captureCamera(runtime) : undefined;
  releaseStage();
  canvasKey.value = version;
  try {
    await nextTick();
    if (disposed || version !== loadVersion || !canvas.value) return;
    const next = await createStage(canvas.value, scene, updateFrame, sceneAspect.value, lighting.value, sceneSettings.value);
    if (disposed || version !== loadVersion) return disposeStage(next);
    runtime = next;
    loadedScene = scene;
    updateAspect();
    controls = new PointerLockControls(runtime.camera, canvas.value);
    controls.addEventListener("change", () => runtime?.invalidate());
    controls.addEventListener("lock", () => {
      controlling.value = true;
      if(!recordingCameraActive.value)activeAnchorId.value = "";
    });
    controls.addEventListener("unlock", () => {
      controlling.value = false;
      pressedKeys.clear();
    });
    orbit = new OrbitControls(runtime.camera, canvas.value);
    orbit.target.copy(new Vector3(scene.sceneConfig.controls.target.x, scene.sceneConfig.controls.target.y, scene.sceneConfig.controls.target.z));
    orbit.enabled = viewMode.value === 'stage';
    orbit.addEventListener('start',()=>framedTarget.value=undefined);
    orbit.addEventListener('change', () => { runtime?.invalidate(); updateLabels(); });
    gizmo = new TransformControls(runtime.camera, canvas.value);
    gizmo.setSize(0.8);
    runtime.scene.add(gizmo.getHelper());
    gizmo.addEventListener('dragging-changed', event => {
      if (orbit) orbit.enabled = !event.value && viewMode.value === 'stage';
      if (event.value) wasDragging = true;
      else commitTransform();
    });
    gizmo.addEventListener('objectChange', () => { gizmoRevision.value++; if (assemblyProxy && gizmo?.object === assemblyProxy) { const patch = transformPatch(); if (patch) previewObject(selectedObjectId.value, patch); } updateSelectionOutline(); updateLabels(); runtime?.invalidate(); });
    setAnimation();
    if (previousView) { applyCamera(runtime.camera, previousView); orbit.target.copy(runtime.camera.position).addScaledVector(runtime.camera.getWorldDirection(new Vector3()), 5); manualCamera.value = true; }
    syncCameraRigs();
    attachSelection();
    gizmo.setTranslationSnap(sceneSettings.value.snapToGrid ? 0.25 : null);
    gizmo.setRotationSnap(sceneSettings.value.snapToGrid ? Math.PI / 12 : null);
    applyLighting(runtime, lighting.value);
    refreshThumbnails();
    sampleTime();
    resizeEditor();
    runtime.start();
    ready.value = true;
    if (!previousView && viewMode.value === 'stage') { cameraView = captureCamera(runtime); runtime.camera.position.set(6, 2, 10); orbit.target.set(0, 1.2, 0); runtime.camera.lookAt(orbit.target); if (props.scene.objectList.length) focusObject(''); }
    if(previousView&&viewMode.value==='stage'&&framedTarget.value!==undefined)reframeTarget(framedTarget.value);
    const previousAnchor=anchors.value.find(a=>a.id===previousAnchorId);
    if(previousAnchor){selectedObjectId.value='';activeAnchorId.value=previousAnchor.id;if(viewMode.value==='camera')restoreAnchor(previousAnchor);else syncCameraRigs();}
    if (!previousAnchor && !selectedObjectId.value && props.scene.objectList.length) {
      const first = props.scene.objectList.find(o => o.objType === 'mannequin') ?? props.scene.objectList[0]!;
      selectedObjectId.value = first.assembly?.id ?? first.threeJsonId;
    }
    updateLabels();
    previewSelectedPlan();
  } catch (error) {
    if (!disposed && version === loadVersion) {
      releaseStage();
      loadError.value = error instanceof Error ? error.message : translate('场景载入失败');
      ElMessage.error(loadError.value);
    }
  }
}
// The dialog lazily mounts its canvas. Watch that mount directly: open can fire
// before the ref exists, while opened may wait forever in an occluded window.
watch(canvas, value => { if (value && canvasKey.value === 0) void loadScene(); }, { flush: 'post' });

// 属性面板的修改直接作用到三维物体上预览，保存后不重建整个舞台，保留当前取景。
function previewObject(id: string, patch: ObjectPatch) {
  if (assemblies.value.some(group => group.id === id)) {
    try {
      const next = editStageAsset(props.scene, assemblyObjectPatch(id, patch)).scene;
      for (const part of next.objectList.filter(object => object.assembly?.id === id)) previewObject(part.threeJsonId, { name: part.name ?? '', position: part.position, rotation: part.rotation ?? { rotationX: 0, rotationY: 0, rotationZ: 0 }, scale: part.scale ?? { scaleX: 1, scaleY: 1, scaleZ: 1 }, color: part.material.color, roughness: part.material.roughness, metalness: part.material.metalness });
      if (assemblyProxy) { assemblyProxy.position.set(patch.position.x, patch.position.y, patch.position.z); assemblyProxy.rotation.set(patch.rotation.rotationX, patch.rotation.rotationY, patch.rotation.rotationZ); assemblyProxy.scale.setScalar(patch.scale.scaleX); }
    } catch { /* Invalid transient numeric input is rejected again at commit. */ }
    return;
  }
  const target = runtime && getObjectByThreeJsonId(id, runtime.scene);
  if (!runtime || !target) return;
  target.position.set(patch.position.x, patch.position.y, patch.position.z);
  target.rotation.set(patch.rotation.rotationX, patch.rotation.rotationY, patch.rotation.rotationZ);
  target.scale.set(patch.scale.scaleX, patch.scale.scaleY, patch.scale.scaleZ);
  target.traverse(part => {
    if (part instanceof Mesh && !Array.isArray(part.material) && "color" in part.material) (part.material as { color: { set(value: string): void } }).color.set(patch.color);
  });
  if (patch.pose) for (const name of mannequinJoints) {
    const rotation = patch.pose[name] ?? { x: 0, y: 0, z: 0 };
    target.getObjectByName(name)?.rotation.set(rotation.x, rotation.y, rotation.z);
  }
  target.traverse(part => { if (part instanceof Mesh && !Array.isArray(part.material)) {
    if (patch.roughness !== undefined && 'roughness' in part.material) part.material.roughness = patch.roughness;
    if (patch.metalness !== undefined && 'metalness' in part.material) part.material.metalness = patch.metalness;
  } });
  refreshTrackedCameras(); updateSelectionOutline(); updateLabels();
  runtime.invalidate();
}
// 只差物体名称、位置、旋转、缩放、颜色的两份场景视为同一结构，可原地更新。
function sceneStructure(value: SceneDocument) {
  return JSON.stringify({ ...value, objectList: value.objectList.map(({ name: _name, position: _position, rotation: _rotation, scale: _scale, pose: _pose, posePresetHeight: _poseHeight, assembly: _assembly, material, ...rest }) => ({ ...rest, material: { ...material, color: "", roughness: 0, metalness: 0 } })) });
}

function setAnimation() {
  if (!runtime) return;
  pausePlayback();
  exitControl();
  activeAnchorId.value = "";
  scenePlayer?.dispose();
  scenePlayer = undefined;
  cameraFrames = undefined;
  resetScenePose(runtime,props.scene);
  if (props.result) {
    scenePlayer = prepareSceneAnimation(runtime, props.result);
    cameraFrames = prepareMotion(props.result.cameraFrames);
  }
  currentTime.value = 0;
  previousFrame = performance.now();
  manualCamera.value = false;
  sampleTime();
}

function updateFrame() {
  if (playing.value || controlling.value) { runtime?.invalidate(); updateLabels(); }
  const now = performance.now();
  const elapsed = Math.max(0, (now - previousFrame) / 1000);
  previousFrame = now;
  if (playing.value && props.result) {
    currentTime.value = Math.min(props.result.duration, currentTime.value + elapsed);
    sampleTime();
    if (currentTime.value >= props.result.duration) playing.value = false;
  }
  if (!runtime || !controls?.isLocked || !pressedKeys.size) return;
  movement
    .set(
      Number(pressedKeys.has("KeyD")) - Number(pressedKeys.has("KeyA")),
      Number(pressedKeys.has("Space")) - Number(pressedKeys.has("ShiftLeft") || pressedKeys.has("ShiftRight")),
      Number(pressedKeys.has("KeyW")) - Number(pressedKeys.has("KeyS"))
    )
    .normalize()
    .multiplyScalar(Math.min(elapsed, 0.05) * 8);
  runtime.camera.updateMatrixWorld();
  controls.moveForward(movement.z);
  controls.moveRight(movement.x);
  runtime.camera.position.y += movement.y;
}

function sampleTime() {
  runtime?.invalidate();
  scenePlayer?.setTime(currentTime.value);
  if (runtime && viewMode.value==='camera' && (!manualCamera.value||isTimelineCamera.value&&!!cameraRecordingState.value.error) && cameraFrames) sampleMotion(runtime.camera, cameraFrames, currentTime.value);
  refreshTrackedCameras();
  if (runtime) focalLength.value = runtime.camera.getFocalLength();
  updateSelectionOutline();updateLabels();
}

async function toggleControl() {
  if (!ready.value || !canvas.value?.isConnected || document.hidden || requestingControl) return;
  if (controlling.value) return exitControl();
  pausePlayback();
  manualCamera.value = true;
  canvas.value.focus({ preventScroll: true });
  const target = canvas.value;
  requestingControl = true;
  try {
    await target.requestPointerLock();
    if (disposed || target !== canvas.value || !visible.value) exitControl();
  } catch {
    manualCamera.value = false;
    if (!disposed && visible.value) ElMessage.error(translate("无法锁定鼠标，请点击场景后重试；按 Esc 可退出取景"));
  } finally { requestingControl = false; }
}
function exitControl() {
  pressedKeys.clear();
  controlling.value = false;
  if (document.pointerLockElement === canvas.value) document.exitPointerLock();
}
function handleKeyDown(event: KeyboardEvent) {
  if (event.code === "Escape") {
    event.preventDefault();
    return exitControl();
  }
  if (!controlling.value || event.isComposing || event.ctrlKey || event.metaKey || event.altKey || !moveKeys.has(event.code)) return;
  event.preventDefault();
  event.stopPropagation();
  pressedKeys.add(event.code);
}
function handleKeyUp(event: KeyboardEvent) {
  if (moveKeys.has(event.code)) {
    event.preventDefault();
    pressedKeys.delete(event.code);
  }
}
function setLens(value: number) { if (!runtime || !Number.isFinite(value)) return; if (selectedCamera.value) { const anchor=displayCameraAnchor.value!;updateAnchor({ ...anchor, camera: { ...anchor.camera, fov: Math.min(120,Math.max(10,cameraFov(value,sceneAspect.value))) } }); return; } pausePlayback(); manualCamera.value = true; framedTarget.value=undefined; runtime.camera.setFocalLength(value); focalLength.value = runtime.camera.getFocalLength(); activeAnchorId.value = ''; runtime.invalidate(); }
function changeFocalLength(event: WheelEvent) {
  if (!runtime || !event.deltaY || viewMode.value === 'stage') return;
  pausePlayback();
  manualCamera.value = true;
  const current = runtime.camera.getFocalLength();
  const next =
    event.deltaY < 0
      ? focalSteps.find((value) => value > current + 0.000001) ?? focalSteps.at(-1)!
      : focalSteps.findLast((value) => value < current - 0.000001) ?? focalSteps[0]!;
  if(recordingCameraActive.value&&!controlling.value){setLens(next);return;}
  runtime.camera.setFocalLength(next);
  focalLength.value = runtime.camera.getFocalLength();
  if(!recordingCameraActive.value)activeAnchorId.value = "";
  runtime.invalidate();
}
function pausePlayback() {
  playing.value = false;
}
function togglePlayback() {
  if (!ready.value || !props.result) return;
  if (playing.value) return pausePlayback();
  exitControl();
  if (viewMode.value === 'stage' && runtime) stageView = captureCamera(runtime);
  viewMode.value = 'camera';
  if (orbit) orbit.enabled = false;
  for (const rig of cameraRigs.values()) rig.group.visible = false;
  resizeEditor();
  manualCamera.value = !!selectedCamera.value&&!recordingCameraActive.value;
  if (currentTime.value >= props.result.duration) currentTime.value = 0;
  if(!selectedCamera.value)activeAnchorId.value = "";
  sampleTime();
  previousFrame = performance.now();
  playing.value = true;
}
function seekTime(value: number | number[]) {
  pausePlayback();
  exitControl();
  manualCamera.value = !!selectedCamera.value;
  if(!selectedCamera.value)activeAnchorId.value = "";
  currentTime.value = Math.max(0, Math.min(props.result?.duration ?? 0, Array.isArray(value) ? value[0]! : value));
  sampleTime();
}
function formatTime(value: number) {
  return `${String(Math.floor(value / 60)).padStart(2, "0")}:${String(Math.floor(value % 60)).padStart(2, "0")}.${String(Math.floor((value%1)*100)).padStart(2,"0")}`;
}

function updateAspect() { resizeEditor(); }
watch(sceneAspect, updateAspect);

function captureThumbnail() {
  const thumbnail = document.createElement('canvas'); thumbnail.width = 192; thumbnail.height = Math.round(192 / sceneAspect.value);
  const stage = runtime!, size = stage.renderer.getSize(new Vector2()), aspect = stage.camera.aspect;
  const helperVisible = gizmo?.getHelper().visible, outlineVisible = outline?.visible;
  const rigVisibility = [...cameraRigs.values()].map(rig => [rig.group, rig.group.visible] as const);
  try {
    if (gizmo) gizmo.getHelper().visible = false; if (outline) outline.visible = false;
    for (const [group] of rigVisibility) group.visible = false;
    stage.camera.aspect = sceneAspect.value; stage.camera.updateProjectionMatrix(); stage.renderer.setSize(thumbnail.width, thumbnail.height, false);
    stage.renderer.render(stage.scene, stage.camera);
    thumbnail.getContext('2d')!.drawImage(stage.renderer.domElement,0,0,thumbnail.width,thumbnail.height);
    return thumbnail.toDataURL('image/jpeg',.75);
  } finally {
    stage.renderer.setSize(size.x,size.y,false); stage.camera.aspect = aspect; stage.camera.updateProjectionMatrix();
    if (gizmo) gizmo.getHelper().visible = helperVisible ?? true; if (outline) outline.visible = outlineVisible ?? true;
    for (const [group,visible] of rigVisibility) group.visible = visible;
    stage.invalidate();
  }
}
function refreshThumbnails() {
  if (!runtime||!runtimeMatchesDocument()) return;
  const view = captureCamera(runtime); anchorPreviews.value = {};
  for (const anchor of anchors.value) { scenePlayer?.setTime(anchor.time ?? 0); applyCamera(runtime.camera,anchor); anchorPreviews.value[anchor.id] = captureThumbnail(); }
  scenePlayer?.setTime(currentTime.value); applyCamera(runtime.camera,view); runtime.invalidate();
}
function captureLightingReference() {
  pausePlayback();
  exitControl();
  if (!runtime) return;
  const forward = runtime.camera.getWorldDirection(new Vector3());
  // 俯拍或仰拍时从镜头右方向取水平朝向，避免正前方投影接近零。
  const right = new Vector3(1, 0, 0).applyQuaternion(runtime.camera.quaternion);
  const angle = Math.hypot(forward.x, forward.z) > 0.0001 ? Math.atan2(-forward.x, -forward.z) : Math.atan2(-right.z, right.x);
  lightingReference.value = (angle * 180 / Math.PI + 360) % 360;
}
function updateLighting(value: Partial<LightingSettings>) {
  lighting.value = { ...lighting.value, ...value };
}
watch(lighting, value => {
  lightingDraft.value = { ...value };
  if (!runtime) return;
  applyLighting(runtime, value);
  refreshThumbnails();
});
watch(sceneSettings, async value => {
  const stage = runtime;
  if (!stage) return;
  try {
    await applySceneSettings(stage, value);
    if (runtime !== stage || disposed) return;
    updateLabels(); refreshThumbnails();
  } catch { if (!disposed) ElMessage.error(translate('全景背景读取失败')); }
});
// 拖动地面透明度时只改材质，松手后再保存设置并重新生成缩略图。
const groundOpacityDraft = ref<number>();
function previewGroundOpacity(value: number) {
  groundOpacityDraft.value = value;
  const ground = runtime?.scene.getObjectByName('directorGround') as Mesh | undefined;
  if (!runtime || !ground) return;
  const material = ground.material as MeshBasicMaterial;
  if (material.transparent !== value < 1) { material.transparent = value < 1; material.needsUpdate = true; }
  material.opacity = value; material.depthWrite = value >= 1; runtime.invalidate();
}
// 拖动时只更新灯光，松手后再保存参数并重新生成缩略图。
watch(() => [lightingDraft.value.azimuth, lightingDraft.value.elevation], ([azimuth, elevation]) => {
  if (runtime) applyLighting(runtime, { ...lighting.value, azimuth: azimuth!, elevation: elevation! });
});
function captureCameraAction(){if(recordingCameraActive.value&&displayCameraAnchor.value){const view=viewMode.value==='camera'&&runtime?cameraViewIntoBindings(captureCamera(runtime),displayCameraAnchor.value,runtime.camera.userData.directorResolveTarget):{camera:displayCameraAnchor.value.camera,controls:displayCameraAnchor.value.controls};void recordCameraView(view);return;}return addAnchor();}
function addAnchor() {
  if (processing.value || !runtime) return;
  if (anchors.value.length >= 100) return void ElMessage.warning(translate("最多记录 100 个机位"));
  pausePlayback();
  const names = new Set(anchors.value.map(anchor => anchorName(anchor))); let index = anchors.value.length + 1; while (names.has(translate('机位 {0}', { 0: index }))) index++;
  const anchor = anchorSchema.parse({ ...captureCamera(runtime), name: translate('机位 {0}', { 0: index }), time: currentTime.value });
  anchorPreviews.value[anchor.id] = captureThumbnail();
  anchors.value = [...anchors.value, anchor];
  selectedObjectId.value = ''; activeAnchorId.value = anchor.id; rightTab.value = 'properties';
  captureFlash.value++;
  return anchor;
}
/** Shot presets frame the selected character (else the first one) and open the new camera's view. */
function addCameraPreset(presetId: string, subjectId = selectedObjectId.value) {
  if (presetId === 'current') { timelineOpen.value = true; captureCameraAction(); return; }
  if (processing.value || !runtime) return;
  if (anchors.value.length >= 100) return void ElMessage.warning(translate("最多记录 100 个机位"));
  const actors = props.scene.objectList.filter(object => object.objType === 'mannequin');
  const subject = actors.find(object => object.threeJsonId === subjectId) ?? actors[0];
  const target = subject && getObjectByThreeJsonId(subject.threeJsonId, runtime.scene);
  if (!subject || !target) return;
  pausePlayback(); exitControl();
  runtime.scene.updateMatrixWorld(true);
  const bounds = new Box3().setFromObject(target), root = target.getWorldPosition(new Vector3());
  const facing = new Vector3(0, 0, 1).applyQuaternion(target.getWorldQuaternion(new Quaternion()));
  // The nearest other character's head, for over-the-shoulder shots.
  const headOf = (id: string) => { const object = getObjectByThreeJsonId(id, runtime!.scene); if (!object) return; const box = new Box3().setFromObject(object), point = object.getWorldPosition(new Vector3()); return point.setY(box.min.y + (box.max.y - box.min.y) * 0.9); };
  const other = actors.filter(object => object !== subject).map(object => headOf(object.threeJsonId)).filter(point => !!point).sort((a, b) => a.distanceTo(root) - b.distanceTo(root))[0];
  const view = shotPresetView(presetId, { id: subject.threeJsonId, root: { x: root.x, y: bounds.min.y, z: root.z }, origin: { x: root.x, y: root.y, z: root.z }, yaw: Math.atan2(facing.x, facing.z), height: bounds.max.y - bounds.min.y, other: other && { x: other.x, y: other.y, z: other.z } }, sceneAspect.value);
  const names = new Set(anchors.value.map(anchor => anchorName(anchor))), base = translate(shotPresets.find(preset => preset.id === presetId)!.name);
  let name = base; for (let index = 2; names.has(name); index++) name = `${base} ${index}`;
  const anchor = anchorSchema.parse({ ...view, camera: { ...view.camera, near: runtime.camera.near, far: runtime.camera.far }, name, time: currentTime.value });
  anchors.value = [...anchors.value, anchor];
  restoreAnchor(anchor);
  anchorPreviews.value[anchor.id] = captureThumbnail();
  captureFlash.value++;
  return anchor;
}
function restoreAnchor(anchor: CameraAnchor) {
  if (!runtime || !ready.value) return;
  pausePlayback();
  exitControl();
  selectedObjectId.value = ''; activeAnchorId.value = anchor.id; rightTab.value = 'properties';
  if (viewMode.value === 'stage' && runtime) stageView = captureCamera(runtime);
  viewMode.value = 'camera';
  if (orbit) orbit.enabled = false;
  attachSelection();
  manualCamera.value = true;
  const shown=recordingCameraActive.value&&anchor.id===activeAnchorId.value?displayCameraAnchor.value??anchor:anchor;
  if (!recordingCameraActive.value&&anchor.time !== undefined) { currentTime.value = Math.min(props.result?.duration ?? 0, anchor.time); scenePlayer?.setTime(currentTime.value); }
  applyCamera(runtime.camera, shown); cameraView = shown; resizeEditor();
  for (const rig of cameraRigs.values()) rig.group.visible = false;
  focalLength.value = runtime.camera.getFocalLength();
  activeAnchorId.value = anchor.id;
  if (!anchorPreviews.value[anchor.id]) anchorPreviews.value[anchor.id] = captureThumbnail();
  runtime.invalidate();
}
function removeAnchor(id: string) {
  if(recordingCameraActive.value){ElMessage.info(translate('请先关闭镜头录帧，再删除基础机位'));return;}
  if (processing.value) return;
  delete anchorPreviews.value[id];
  anchors.value = anchors.value.filter((anchor) => anchor.id !== id);
  if (activeAnchorId.value === id) activeAnchorId.value = "";
}

const inspectorObjects=computed(()=>{
  currentTime.value;gizmoRevision.value;
  if(!recordingActorActive.value||!props.result||!runtimeMatchesDocument()||!runtime)return props.scene.objectList;
  const snapshot=selectedPose();if(!snapshot)return props.scene.objectList;
  const sampled=sampledObjectPose(props.scene,props.result,snapshot.objectId,currentTime.value);
  return props.scene.objectList.map(o=>o.threeJsonId!==snapshot.objectId?o:{...o,position:snapshot.position,rotation:{rotationX:snapshot.rotation.x,rotationY:snapshot.rotation.y,rotationZ:snapshot.rotation.z},scale:{scaleX:snapshot.scale.x,scaleY:snapshot.scale.y,scaleZ:snapshot.scale.z},pose:snapshot.joints,posePresetHeight:sampled.posePresetHeight??0});
});
async function commitObject(id:string,patch:ObjectPatch){
  if(!recordingActorActive.value){emit('updateObject',id,patch);return;}
  if(!props.result||recordBusy.value||editLocked.value)return;
  recordBusy.value=true;
  try{const pose=patch.pose?Object.fromEntries(mannequinJoints.map(joint=>[joint,patch.pose?.[joint]??{x:0,y:0,z:0}])):undefined;
    await props.editTimeline({action:'edit',operations:[{action:'recordPose',objectId:id,time:currentTime.value,position:patch.position,rotation:{x:patch.rotation.rotationX,y:patch.rotation.rotationY,z:patch.rotation.rotationZ},scale:{x:patch.scale.scaleX,y:patch.scale.scaleY,z:patch.scale.scaleZ},pose,posePresetHeight:patch.posePresetHeight}]});
  }catch{ElMessage.error(translate('录帧参数无效，请检查位置、角度与缩放'));}finally{recordBusy.value=false;sampleTime();}
}

async function recordCameraView(view:CameraView,time=currentTime.value){
 if(!props.result||recordBusy.value||editLocked.value||cameraRecordingState.value.error)return false;
 recordBusy.value=true;try{return await props.editTimeline({action:'edit',operations:[{action:'recordCamera',time,view:cameraViewSchema.parse(view)}]});}
 catch{ElMessage.error(translate('镜头录帧参数无效，原方案已保留'));return false;}
 finally{recordBusy.value=false;sampleTime();}
}
watch([()=>cameraRecordingState.value.view,recordingCameraActive,ready,playing],()=>{
 const view=cameraRecordingState.value.view;if(!recordingCameraActive.value){recordingCameraPreview.value='';return;}if(!view){recordingCameraPreview.value='';return;}if(!ready.value||playing.value||!runtimeMatchesDocument()||!runtime)return;
 const previous=captureCamera(runtime);try{applyCamera(runtime.camera,view);recordingCameraPreview.value=captureThumbnail();}finally{applyCamera(runtime.camera,previous);runtime.invalidate();}
},{flush:'post'});
watch(recordingCameraActive,()=>{if(ready.value){if(selectedCamera.value&&viewMode.value==='camera'&&!playing.value)manualCamera.value=true;syncCameraRigs();sampleTime();}});

watch(recordKeyframes,enabled=>{if(enabled)aiMode.value='animation';else if(activeAnchorId.value===timelineCameraId){activeAnchorId.value='';manualCamera.value=false;syncCameraRigs();sampleTime();}});
watch(()=>cameraRecordingState.value.error,()=>{if(isTimelineCamera.value)syncCameraRigs();});
watch(aiMode,mode=>{if(mode==='scene')recordKeyframes.value=false;});
watch(timelineOpen,open=>{if(!open)recordKeyframes.value=false;});
watch(()=>props.selectedPlanId,()=>recordKeyframes.value=false);
watch(canRecordTarget,valid=>{if(!valid)recordKeyframes.value=false;});
function selectedPose(){
  if(!runtime||!runtimeMatchesDocument()||!selectedObjectId.value)return null;
  const object=getObjectByThreeJsonId(selectedObjectId.value,runtime.scene);if(!object)return null;
  const vector=(v:{x:number;y:number;z:number})=>({x:v.x,y:v.y,z:v.z});
  return {objectId:selectedObjectId.value,position:vector(object.position),rotation:vector(object.rotation),scale:vector(object.scale),joints:props.scene.objectList.find(o=>o.threeJsonId===selectedObjectId.value)?.objType==='mannequin'?Object.fromEntries(mannequinJoints.map(joint=>[joint,vector(object.getObjectByName(joint)!.rotation)])):undefined};
}
function getContext() {
  return { backgroundColor: sceneBackground(props.scene, sceneSettings.value), ready: ready.value && runtimeMatchesDocument() && !props.documentUnavailable && !props.documentLoading, error: props.documentUnavailable ? translate('请重新打开导演台，确认最新场景') : loadError.value, playing: playing.value, recordingKeyframes:recordingActive.value, recordingTarget:recordingCameraActive.value?{kind:'camera' as const,anchorId:isTimelineCamera.value?undefined:selectedCamera.value?.id,cameraTrack:isTimelineCamera.value,planId:props.selectedPlanId,time:currentTime.value}:recordingActorActive.value?{kind:'actor' as const,objectId:selectedObjectId.value,planId:props.selectedPlanId,time:currentTime.value}:null, recordingCameraView:cameraRecordingState.value.view??null, recordingCameraResolvedView:recordingCameraActive.value&&cameraRecordingState.value.view&&resolvedSelectedCamera.value?{camera:resolvedSelectedCamera.value.camera,controls:resolvedSelectedCamera.value.controls}:null, recordingCameraError:cameraRecordingState.value.error??null, selectedPose:selectedPose(), sampledState:runtime&&ready.value&&runtimeMatchesDocument()&&!props.documentUnavailable&&!props.documentLoading?snapshotStage(runtime,props.scene,currentTime.value):null, framing:framingContext(), timeline:timelineOpen.value?timelineView.value?.getViewContext()??null:null, time: currentTime.value, duration: props.result?.duration ?? 0, view: runtime ? captureCamera(runtime) : null, focalLength: focalLength.value, viewMode: viewMode.value, selectedObjectIds: selectedObjectId.value ? [selectedObjectId.value] : [], activeAnchorId: isTimelineCamera.value?'':activeAnchorId.value, selectedTimelineCamera:isTimelineCamera.value, selectedAnchorResolvedView:!isTimelineCamera.value&&selectedCamera.value&&runtimeMatchesDocument()&&runtime?resolveCameraView(selectedCamera.value,runtime.camera.userData.directorResolveTarget):null, selectedAnchor: !isTimelineCamera.value&&selectedCamera.value ? JSON.parse(JSON.stringify(selectedCamera.value)) : null, selectedAnchorFocalLength: !isTimelineCamera.value&&selectedCamera.value ? cameraFocalLength(selectedCamera.value, sceneAspect.value) : null, anchorIds: anchors.value.map(anchor => anchor.id) };
}
function pauseForAgent(){pausePlayback();exitControl();}
async function resumeRecordingTarget(target:{kind:'camera'|'actor';anchorId?:string;cameraTrack?:boolean;objectId?:string;time:number}){
 if(!props.result)return;const planId=props.selectedPlanId,version=++timelineSelectionVersion;
 if(target.kind==='camera'){
  if(!target.cameraTrack&&!anchors.value.some(anchor=>anchor.id===target.anchorId))return;
  selectedObjectId.value='';
 }else{
  if(!props.scene.objectList.some(object=>object.threeJsonId===target.objectId&&object.objType==='mannequin'))return;
  activeAnchorId.value='';selectedObjectId.value=target.objectId!;
 }
 await nextTick();if(disposed||!props.result||props.selectedPlanId!==planId||version!==timelineSelectionVersion)return;
 if(target.kind==='camera')activeAnchorId.value=target.cameraTrack?timelineCameraId:target.anchorId!;
 timelineOpen.value=true;recordKeyframes.value=true;aiMode.value='animation';
 seekTime(Math.max(0,Math.min(props.result.duration,target.time)));syncCameraRigs();attachSelection();
}

defineExpose({ getContext, selectAnchor, seekTime, pauseForAgent,resumeRecordingTarget });

nodeTools.register({
  name: 'controlDirectorView', description: '操作已打开的导演台预览：status 查询是否就绪、当前真实镜头/焦距/时间；play/pause/seek 播放定位；setCamera 设置 view 或 focalLength；captureAnchor 捕捉当前镜头为参考关键帧；selectAnchor 选中机位对象但保留导演视角；restoreAnchor 切换到机位取景；frameScene 总览实际场景（不受远处辅助机位影响）；focusObject 按 objectId 选中并聚焦角色、道具或机位；addShot 按 presetId 景别新增机位并切到该机位取景，objectId 指定主体人偶（省略用当前选中或第一个人偶），过肩镜头看向最近的另一角色，侧面跟拍会绑定跟随与注视。status.framing 返回当前可用画面及投影范围。recordCamera 将 view（省略使用当前动画镜头或预览）录入 time（省略为播放头）的动画镜头轨道，保留基础机位。其他动作只控制预览，不调用模型。',
  parameters: z.strictObject({ action: z.enum(['status','play','pause','seek','setCamera','captureAnchor','restoreAnchor','selectAnchor','frameScene','focusObject','recordCamera','addShot']), presetId: z.enum(shotPresets.map(preset => preset.id) as [string, ...string[]]).describe(shotPresets.map(preset => `${preset.id}=${preset.name}`).join('，')).optional(), objectId:z.string().min(1).max(100).optional(), time: z.number().min(0).max(300).optional(), view: cameraViewSchema.optional(), focalLength: z.number().min(6).max(110).optional(), anchorId: z.string().min(1).optional() }),
  async execute(args, { signal }) {
    signal?.throwIfAborted();
    const status = getContext;
    if (args.action === 'status') return status();
    if (disposed || !runtime || !ready.value || !runtimeMatchesDocument() || props.documentUnavailable || props.documentLoading) throw new Error('导演台预览尚未就绪，请先查询 status');
    if (props.exportingVideo || props.exportingImage || props.addingMannequin || props.tasks.some(isDirectorGenerationPending)) throw new Error('导演台正在处理，请等待完成');
    if(args.action==='recordCamera'){if(!props.result)throw Error(translate('请先选择动画方案'));const view=args.view??(recordingCameraActive.value?cameraRecordingState.value.view:captureCamera(runtime));if(!view||!await recordCameraView(view,args.time??currentTime.value))throw Error(cameraRecordingState.value.error??translate('镜头录帧参数无效，原方案已保留'));await nextTick();return status();}
    if(args.action==='addShot'){if(!args.presetId)throw Error('请提供 presetId');if(args.objectId&&!props.scene.objectList.some(o=>o.threeJsonId===args.objectId&&o.objType==='mannequin'))throw Error('objectId 必须是场景中的人偶');if(!props.scene.objectList.some(o=>o.objType==='mannequin'))throw Error('请先添加人偶');if(anchors.value.length>=100)throw Error('最多记录 100 个机位');const anchor=addCameraPreset(args.presetId,args.objectId);await nextTick();return{...status(),anchor};}
    if(args.action==='frameScene')focusObject('');
    else if(args.action==='focusObject'){if(!args.objectId||!props.scene.objectList.some(o=>o.threeJsonId===args.objectId)&&!assemblies.value.some(a=>a.id===args.objectId)&&!anchors.value.some(a=>a.id===args.objectId))throw Error('请提供存在的角色、道具或机位 objectId');if(anchors.value.some(a=>a.id===args.objectId))selectAnchor(args.objectId);else{activeAnchorId.value='';selectedObjectId.value=args.objectId;}focusObject(args.objectId);}
    else if (args.action === 'play') {
      if (!props.result) throw new Error('请先创建或选择动画方案');
      if (!playing.value) togglePlayback();
    } else if (args.action === 'pause') pausePlayback();
    else if (args.action === 'seek') {
      if (args.time === undefined || !props.result || args.time > props.result.duration) throw new Error('请选择当前动画时长内的 time');
      seekTime(args.time);
    } else if (args.action === 'setCamera') {
      if (!args.view && args.focalLength === undefined) throw new Error('请提供 view 或 focalLength');
      pausePlayback(); exitControl(); manualCamera.value = true;
      framedTarget.value=undefined;
      if (args.view) { applyCamera(runtime.camera, args.view); if (orbit) { orbit.target.set(args.view.controls.target.x,args.view.controls.target.y,args.view.controls.target.z); orbit.update(); } }
      if (args.focalLength !== undefined) runtime.camera.setFocalLength(args.focalLength);
      focalLength.value = runtime.camera.getFocalLength(); activeAnchorId.value = '';
    } else if (args.action === 'selectAnchor') {
      if (!anchors.value.some(anchor => anchor.id === args.anchorId)) throw new Error('关键帧不存在');
      selectAnchor(args.anchorId!);
    } else if (args.action === 'restoreAnchor') {
      const anchor = anchors.value.find(anchor => anchor.id === args.anchorId);
      if (!anchor) throw new Error('关键帧不存在');
      restoreAnchor(anchor);
    } else {
      if (anchors.value.length >= 100) throw new Error('最多记录 100 个机位');
      const anchor = addAnchor();
      await nextTick();
      return { ...status(), anchor };
    }
    runtime.invalidate();
    await nextTick();signal?.throwIfAborted();
    if((args.action==='focusObject'||args.action==='frameScene')&&framedTarget.value!==undefined)reframeTarget(framedTarget.value);
    return status();
  },
});

function closeEditor() {
  pausePlayback();
  exitControl();
  visible.value = false;
  // A full-window editor must close even when Chromium pauses CSS transitions.
  emit("close");
}
function releaseStage() {
  orbit?.dispose(); orbit = undefined;
  for (const rig of cameraRigs.values()) { runtime?.scene.remove(rig.group); rig.dispose(); } cameraRigs.clear();
  gizmo?.dispose(); gizmo = undefined; assemblyProxy = undefined;
  outline?.geometry.dispose(); if (outline) (Array.isArray(outline.material) ? outline.material : [outline.material]).forEach(material => material.dispose()); outline = undefined;
  controls?.dispose();
  controls = undefined;
  scenePlayer?.dispose();
  scenePlayer = undefined;
  cameraFrames = undefined;
  if (runtime) disposeStage(runtime);
  runtime = undefined;
}
function blurEditor() {
  pausePlayback();
  exitControl();
}
watch(() => props.exportingVideo, exporting => { if (exporting) { pausePlayback(); exitControl(); } });
watch([currentTime, playing, controlling, sceneAspect, focalLength, activeAnchorId], () => runtime?.invalidate());
watch(
  () => [props.scene, props.result],
  () => {
    if(ready.value&&runtime&&loadedScene&&props.scene===loadedScene){
      const view=captureCamera(runtime),time=currentTime.value,manual=manualCamera.value,anchorId=activeAnchorId.value;
      setAnimation();currentTime.value=Math.min(time,props.result?.duration??0);manualCamera.value=manual;activeAnchorId.value=anchorId;sampleTime();
      if(viewMode.value==='stage'||manual&&!selectedCamera.value)applyCamera(runtime.camera,view);
      attachSelection();refreshThumbnails();return;
    }
    if (ready.value && runtime && loadedScene && props.scene !== loadedScene && sceneStructure(props.scene) === sceneStructure(loadedScene)) {
      for (const object of props.scene.objectList) {
        previewObject(object.threeJsonId, {
          name: object.name ?? "", position: object.position,
          rotation: object.rotation ?? { rotationX: 0, rotationY: 0, rotationZ: 0 },
          scale: object.scale ?? { scaleX: 1, scaleY: 1, scaleZ: 1 }, color: object.material.color, pose: object.pose, roughness: object.material.roughness, metalness: object.material.metalness,
        });
      }
      loadedScene = props.scene;
      if (props.result) {
        const view = captureCamera(runtime), time = Math.min(currentTime.value,props.result?.duration??0), manual = manualCamera.value,anchorId=activeAnchorId.value;
        setAnimation(); currentTime.value = time; manualCamera.value = manual; activeAnchorId.value=anchorId;sampleTime();
        if (viewMode.value==='stage'||manual&&!selectedCamera.value) applyCamera(runtime.camera, view);
      }
      refreshTrackedCameras(); attachSelection();
      refreshThumbnails();
      return;
    }
    if (!ready.value || props.scene !== loadedScene) return void loadScene();
    try {
      setAnimation();
    } catch (error) {
      ElMessage.error(error instanceof Error ? error.message : translate("动画载入失败"));
    }
  },
  { flush: "post" }
);
onMounted(() => {
  anchors.value = anchors.value.map((anchor) => anchorSchema.parse(anchor));
  emit("loadModels");
  window.addEventListener("blur", blurEditor);
  document.addEventListener("visibilitychange", blurEditor);
});
onBeforeUnmount(() => {
  disposed = true;
  ++loadVersion;
  blurEditor();
  releaseStage();
  window.removeEventListener("blur", blurEditor);
  document.removeEventListener("visibilitychange", blurEditor);
});
</script>

<style lang="scss" scoped>
.sceneSettingsPanel {
  max-height: calc(100dvh - 80px);
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: 4px;
  font-size: 12px;
  color: var(--el-text-color-regular);

  .settingRow {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    min-height: 32px;
    > .el-input-number { width: 88px; }
    > .colorField { flex: 0 1 168px; }
    &.sliderRow { display: grid; grid-template-columns: auto minmax(0, 1fr) 56px; .el-slider { margin: 0 4px; } > .el-input-number { width: 56px; } }
  }
}
.lightingPanel {
  display: flex;
  flex-direction: column;
  gap: 4px;
  max-height: min(440px, calc(100dvh - 80px));
  overflow-x: hidden;
  overflow-y: auto;
  font-size: 12px;
  color: var(--el-text-color-regular);

  .lightingRow {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    min-height: 32px;

    .el-input-number {
      width: 72px;
    }
    .colorField { width: 128px; }

    .lightingInputs {
      display: flex;
      align-items: center;
      gap: 8px;
    }

    small {
      margin-left: 4px;
      color: var(--el-text-color-secondary);
      font-size: 11px;
    }
  }
}
.directorHeader {
  display: flex;
  align-items: center;
  gap: 8px;
  height: 48px;
  padding: 0 max(12px, var(--desktop-caption-right, 0px)) 0 max(12px, var(--desktop-caption-left, 0px));
  -webkit-app-region: drag;
  border-bottom: 1px solid var(--el-border-color-lighter);
  color: var(--el-text-color-primary);
  font-size: 14px;
  font-weight: 500;
  .closeButton { margin-right: 4px; flex-shrink: 0; -webkit-app-region: no-drag; }
  > svg, > span { flex-shrink: 0; white-space: nowrap; }
  .headerTools { flex-shrink: 0; -webkit-app-region: no-drag; }
  small {
    min-width: 0;
    font-size: 12px;
    font-weight: 400;
    color: var(--el-text-color-secondary);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    &::before { content: "·"; margin-right: 8px; }
  }
}
.directorWorkspace {
  display: grid;
  height: 100%;
  min-height: 0;
  > .sceneOutline {
    padding: 14px 12px;
    border-right: 1px solid var(--el-border-color-lighter);
  }
  > :deep(.directorPanel) {
    padding: 14px 16px;
    border-left: 1px solid var(--el-border-color-lighter);
  }
  .addObject { margin: 0; }
  .stagePanel {
    display: flex;
    flex-direction: column;
    min-width: 0;
    min-height: 0;
    .viewport {
      position: relative;
      display: grid;
      place-items: center;
      container-type: size;
      container-name: director-stage;
      flex: 1;
      min-height: 160px;
      overflow: hidden;
      background: var(--el-fill-color-darker);
      .sceneCanvas,
      .captureFlash {
        width: min(100cqw, calc(100cqh * var(--sceneAspect)));
        height: min(100cqh, calc(100cqw / var(--sceneAspect)));
      }
      .sceneCanvas {
        display: block;
        object-fit: contain;
        touch-action: none;
        outline: 3px solid transparent;
        outline-offset: -3px;
        transition: outline-color 0.2s, box-shadow 0.2s;
        &.playing {
          outline-color: var(--el-color-primary);
          box-shadow: 0 0 18px color-mix(in srgb, var(--el-color-primary) 35%, transparent);
        }
      }
      .captureFlash {
        position: absolute;
        inset: 0;
        margin: auto;
        background: #fff;
        opacity: 0;
        pointer-events: none;
        animation: directorCapture 280ms ease-out;
        @media (prefers-reduced-motion: reduce) {
          background: transparent;
          box-shadow: inset 0 0 0 2px var(--el-color-primary);
          animation-timing-function: step-end;
        }
      }
      .viewportInfo {
        position: static;
        display: flex;
        justify-content: space-between;
        color: #fff;
        font-size: 11px;
        text-shadow: 0 1px 4px #000;
        pointer-events: none;
        font-variant-numeric: tabular-nums;
      }
      .stageLoading {
        position: absolute;
        inset: 0;
        display: flex;
        flex-direction: column;
        gap: 12px;
        align-items: center;
        justify-content: center;
        background: var(--el-bg-color-overlay);
        color: var(--el-text-color-secondary);
        font-size: 12px;
        z-index: 1;
        .loadingIcon {
          animation: directorLoading 1s linear infinite;
        }
      }
    }
    .keyframeDock {
      flex-shrink: 0;
      padding: 0 12px 12px;
      border-top: 1px solid var(--el-border-color-lighter);
      background: #18191b;
      .iconButton { width: 28px; height: 28px; margin: 0; color: var(--el-text-color-regular); }
      .iconButton.active { background: rgba(255,255,255,.12); color: var(--el-text-color-primary); }
      .timeLabel { min-width: 104px; color: var(--el-text-color-secondary); font-size: 12px; font-variant-numeric: tabular-nums; white-space: nowrap; }
      :deep(.timelineHeader) > .el-button { margin: 0; }
    }
    .referenceHeader {
      display: flex;
      justify-content: space-between;
      align-items: center;
      padding-bottom: 8px;
      font-size: 12px;
      color: var(--el-text-color-regular);
      small {
        color: var(--el-text-color-secondary);
        font-size: 11px;
        margin-left: 4px;
      }
    }
    .referenceList {
      display: flex;
      gap: 10px;
      min-height: 68px;
      overflow-x: auto;
      padding: 2px;
      scrollbar-width: thin;
      .referenceAdd {
        flex: 0 0 64px;
        height: 64px;
        display: grid;
        place-items: center;
        border: 1px dashed rgba(255,255,255,.14);
        border-radius: var(--el-border-radius-base);
        background: transparent;
        color: var(--el-text-color-secondary);
        cursor: pointer;
        &:hover:not(:disabled) { color: var(--el-text-color-primary); border-color: var(--el-text-color-secondary); }
        &:disabled { cursor: not-allowed; opacity: 0.5; }
      }
      .referenceItem {
        position: relative;
        flex: 0 0 108px;
        height: 64px;
        border: 1px solid transparent;
        border-radius: var(--el-border-radius-base);
        overflow: hidden;
        &.selected {
          border-color: var(--el-color-primary);
        }
        .referenceImage {
          display: flex;
          align-items: center;
          justify-content: center;
          width: 108px;
          height: 64px;
          border: 0;
          padding: 0;
          background: var(--el-fill-color);
          color: var(--el-text-color-placeholder);
          cursor: grab;
          img {
            width: 100%;
            height: 100%;
            object-fit: contain;
          }
          span {
            position: absolute;
            bottom: 5px;
            left: 7px;
            color: #fff;
            background: #0006;
            padding: 1px 4px;
            border-radius: 3px;
            font-size: 10px;
          }
        }
        .removeReference {
          position: absolute;
          top: 3px;
          right: 3px;
          width: 22px;
          height: 22px;
          padding: 0;
          background: var(--el-bg-color-overlay);
          color: var(--el-text-color-regular);
          opacity: 0;
        }
        .exportReference {
          position: absolute; right: 3px; bottom: 3px; width: 22px; height: 22px; padding: 0; margin: 0; opacity: 0;
          background: var(--el-bg-color-overlay); color: var(--el-text-color-regular);
        }
        &:hover .exportReference, &:focus-within .exportReference { opacity: 1; }
        &:hover .removeReference,
        &:focus-within .removeReference {
          opacity: 1;
        }
      }
    }
  }
}
@keyframes directorCapture {
  from { opacity: 0.55; }
  to { opacity: 0; }
}
@keyframes directorLoading {
  to {
    transform: rotate(360deg);
  }
}
@media (max-width: 1100px) {
}
@media (max-width: 860px) {
  .directorWorkspace {
    grid-template-columns: 1fr;
    grid-template-rows: minmax(420px, auto) minmax(420px, 1fr) minmax(420px, 1fr);
    overflow-y: auto;
  }
}
@media (prefers-reduced-motion: reduce) {
  .directorWorkspace .stagePanel .viewport .stageLoading .loadingIcon {
    animation: none;
  }
}


.stageToolbar { position:absolute; top:14px; left:16px; right:16px; display:flex; flex-direction:column; gap:6px; pointer-events:none; z-index:2; }
.directorWorkspace .stagePanel .viewTools { display:grid; grid-template-columns:1fr auto 1fr; }
.viewModes { grid-column:2; }
.transformModes { grid-column:3; justify-self:end; }
.framingTools { display:flex; flex-wrap:wrap; align-items:center; justify-content:space-between; gap:4px; }
.stageFooter { position:absolute; left:50%; bottom:16px; transform:translateX(-50%); width:min(760px,calc(100% - 32px)); display:flex; flex-direction:column; gap:8px; pointer-events:none; z-index:2; }
@container director-stage (max-width:480px) {
  .directorWorkspace .stagePanel .viewport .transformModes button { width:26px; height:28px; padding:6px; }
  .directorWorkspace .stagePanel .viewport .viewportInfo { display:none; }
  .directorWorkspace .stagePanel .viewport .viewModes button { font-size:0; gap:0; padding:7px; width:32px; height:32px; }
}


.directorWorkspace { grid-template-columns:var(--leftWidth,280px) minmax(0,1fr) var(--rightWidth,280px); }
.leftWorkspace,.rightWorkspace { position:relative; }
.panelResizer { position:absolute; top:0; bottom:0; width:7px; z-index:5; cursor:col-resize; touch-action:none; }
.leftWorkspace > .panelResizer { right:-4px; }
.rightWorkspace > .panelResizer { left:-4px; }
.panelResizer::after { content:""; position:absolute; top:0; bottom:0; left:3px; width:1px; background:transparent; transition:background .15s; }
.panelResizer:hover::after,.panelResizer.dragging::after,.panelResizer:focus-visible::after { background:rgba(255,255,255,.35); }
.panelResizer:focus-visible { outline:0; }
.leftWorkspace { display:flex; min-width:0; min-height:0; border-right:1px solid var(--el-border-color-lighter); }
.leftWorkspace > .sceneOutline { flex:1; min-width:0; padding:12px 8px; }
.directorRail { width:42px; flex-shrink:0; display:flex; flex-direction:column; gap:8px; padding:10px 4px; border-right:1px solid var(--el-border-color-lighter); }
.directorRail button,.bottomTools button { width:32px; height:32px; display:grid; place-items:center; border:0; border-radius:6px; background:transparent; color:var(--el-text-color-secondary); cursor:pointer; }
.directorRail button:hover:not(:disabled),.directorRail button.active,.bottomTools button:hover,.bottomTools button.active { background:rgba(255,255,255,.1); color:var(--el-text-color-primary); }
.directorRail button:disabled { opacity:.4; cursor:default; }
.rightWorkspace { display:flex; flex-direction:column; min-height:0; min-width:0; border-left:1px solid var(--el-border-color-lighter); }
.rightTabs { flex-shrink:0; display:flex; gap:4px; padding:8px; border-bottom:1px solid var(--el-border-color-lighter); }
.rightTabs button { flex:1; padding:8px; border:0; border-radius:6px; background:transparent; color:var(--el-text-color-secondary); cursor:pointer; }
.rightTabs button.active { background:var(--el-fill-color); color:var(--el-text-color-primary); }
.rightProperties,.assistantHistoryHost { flex:1; min-height:0; min-width:0; overflow:hidden; }
.rightProperties > .sceneOutline { height:100%; padding:8px 10px; }
.environmentInspector { overflow-y:auto; min-height:0; padding:0 6px 16px; }
.environmentInspector h3 { margin:14px 0 8px; font-size:14px; font-weight:600; color:var(--el-text-color-primary); }
.environmentInspector h3:not(:first-child) { margin-top:10px; padding-top:14px; border-top:1px solid var(--el-border-color-lighter); }
.environmentInspector .sceneSettingsPanel,.environmentInspector .lightingPanel { max-height:none; overflow:visible; }
.directorWorkspace .stagePanel { overflow:hidden; }
.directorWorkspace .stagePanel .viewport.stageMode .sceneCanvas,.directorWorkspace .stagePanel .viewport.stageMode .captureFlash,.directorWorkspace .stagePanel .viewport.stageMode .actorLabels { width:100cqw; height:100cqh; }
.bottomControlRow { display:flex; align-items:flex-end; justify-content:center; gap:8px; flex-wrap:wrap; pointer-events:auto; }
.bottomTools { display:flex; flex-shrink:0; gap:4px; padding:6px; border:1px solid rgba(255,255,255,.08); border-radius:24px; background:rgba(32,32,34,.92); backdrop-filter:blur(8px); }
.bottomTools button { border-radius:50%; }
.stageComposer { flex:1 1 180px; min-width:0; max-width:560px; }
.keyframeDock { box-sizing:border-box; max-height:40%; overflow-y:auto; }
@media (min-width:861px) and (max-width:1100px) { .directorWorkspace { grid-template-columns:min(var(--leftWidth,220px),26vw) minmax(0,1fr) min(var(--rightWidth,280px),30vw); } }
@media (max-width:860px) { .directorWorkspace { grid-template-columns:1fr; } .panelResizer { display:none; } }
 .cameraTreeItem { display:flex; align-items:center; gap:8px; min-height:30px; padding:0 8px; width:100%; flex-shrink:0; border:0; border-radius:6px; background:transparent; color:var(--el-text-color-regular); font:inherit; text-align:left; cursor:pointer; }
.cameraTreeItem.selected,.cameraTreeItem:hover { background:var(--el-fill-color); }
.cameraTreeItem span { overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.motionActions { display: flex; flex-wrap:wrap; min-width:0; align-items: center; gap: 6px; font-size: 11px; }
.motionActions :deep(.el-input-number) { width: 55px; }
.motionActions select { padding: 0 8px; font: inherit; font-size: 12px; }
.referenceHeader { flex-wrap: wrap; }
.lensSelect {
  pointer-events:auto;
  appearance:none;
  height:32px;
  background:rgba(32,32,34,.9);
  color:var(--el-text-color-primary);
  border:1px solid rgba(255,255,255,.08);
  padding:0 12px;
  border-radius:10px;
  font-size:12px;
  font-variant-numeric:tabular-nums;
  cursor:pointer
}
.headerTools {
  margin-left:auto;
  display:flex;
  align-items:center;
  gap:4px
}
.headerBadge {
  margin-left:8px;
  padding:4px 8px;
  border-radius:6px;
  background:rgba(255,255,255,.06);
  font-size:11px;
  color:var(--el-text-color-secondary)
}
.viewTools {
  display:flex;
  flex-wrap:wrap;
  align-items:center;
  justify-content:space-between;
  pointer-events:none;
  gap:6px
}
.viewModes,.transformModes,.viewAxis {
  display:flex;
  padding:2px;
  border-radius:10px;
  background:rgba(32,32,34,.9);
  border:1px solid rgba(255,255,255,.08);
  gap:2px;
  pointer-events:auto;
  backdrop-filter:blur(8px)
}
.viewTools button,.viewAxis button {
  display:flex;
  align-items:center;
  justify-content:center;
  gap:6px;
  border:0;
  border-radius:8px;
  height:28px;
  min-width:28px;
  padding:0 8px;
  background:transparent;
  color:var(--el-text-color-secondary);
  font:inherit;
  font-size:12px;
  cursor:pointer
}
.viewTools button.active {
  background:rgba(255,255,255,.12);
  color:var(--el-text-color-primary)
}
.viewTools button:hover:not(:disabled),.viewAxis button:hover:not(:disabled) {
  color:var(--el-text-color-primary)
}
.viewAxis { position:static; }
.compositionGrid,.actorLabels {
  pointer-events:none;
  position:absolute;
  width:min(100cqw,calc(100cqh * var(--sceneAspect)));
  height:min(100cqh,calc(100cqw / var(--sceneAspect)));
  inset:0;
  margin:auto
}
.compositionGrid i,.compositionGrid b {
  position:absolute;
  background:#ffffff44
}
.compositionGrid i {
  width:1px;
  height:100%;
  left:33.333%
}
.compositionGrid i:nth-child(2) {
  left:66.666%
}
.compositionGrid b {
  height:1px;
  width:100%;
  top:33.333%
}
.compositionGrid b:last-child {
  top:66.666%
}
.actorLabels span {
  position:absolute;
  transform:translate(-50%,-100%);
  font-size:11px;
  padding:3px 7px;
  border-radius:4px;
  background:#171a23bb;
  color:#fff;
  white-space:nowrap
}
.lightPresets {
  display:grid;
  grid-template-columns:repeat(4,1fr);
  gap:5px;
  margin-bottom:10px
}
.lightPresets button {
  border:0;
  border-radius:8px;
  padding:8px 2px;
  background:rgba(255,255,255,.06);
  color:var(--el-text-color-regular);
  font:inherit;
  font-size:10px;
  cursor:pointer
}
.lightPresets i {
  display:block;
  width:20px;
  height:20px;
  margin:0 auto 6px;
  border-radius:50%;
  background:var(--lightColor);
  box-shadow:0 0 12px var(--lightColor)
}
</style>

<style lang="scss">
body .el-popper.directorSettingsPopover { overflow: visible; }
.directorColorPanel { max-width: calc(100vw - 16px); max-height: calc(100dvh - 16px); overflow-y: auto; }
// The dialog teleports to body, outside this component's scope: make it a
// full-window editor without the card chrome other dialogs use.
body .el-dialog.directorDialog {
  display: flex;
  flex-direction: column;
  margin: 0;
  padding: 0;
  border: 0 !important;
  border-radius: 0 !important;
  box-shadow: none !important;
  > .el-dialog__header {
    padding: 0;
    margin: 0;
  }
  > .el-dialog__body {
    flex: 1;
    min-height: 0;
    padding: 0;
  }
}
</style>

<style scoped>
.compactViewControls { display:none; }
@container director-stage (max-height:320px) {
  .stageToolbar { top:8px; left:10px; right:10px; gap:4px; }
  .framingTools { flex-wrap:nowrap; }
  .directorWorkspace .stagePanel .viewport .framingTools > .viewAxis { display:none; }
  .compactViewControls { display:flex; align-items:center; gap:4px; min-width:0; }
  .compactViewControls select { width:72px; min-width:0; height:28px; padding:0 4px; border:1px solid var(--el-border-color-light); border-radius:6px; background:var(--el-bg-color-overlay); color:var(--el-text-color-regular); font:inherit; font-size:11px; }
  .stageFooter { bottom:8px; width:min(760px,calc(100% - 20px)); gap:4px; }
  .viewportInfo { display:none; }
  .bottomControlRow { flex-wrap:nowrap; align-items:center; gap:6px; }
  .bottomTools { padding:3px; }
  .bottomTools button { width:24px; height:28px; }
  .stageComposer { flex:1 1 0; }
  .stageFooter :deep(.directorPanel.stagedComposer .chatFooter) { flex-wrap:nowrap; padding:4px; gap:2px; }
  .stageFooter :deep(.directorPanel.stagedComposer .inputContent) { flex:1 1 0; min-width:0; padding:0 3px; }
  .stageFooter :deep(.directorPanel.stagedComposer .inputActions) { flex:0 0 auto; gap:2px; }
  .stageFooter :deep(.directorPanel.stagedComposer .modelSelect) { width:120px; min-width:100px; max-width:120px; }
  .stageFooter :deep(.directorPanel.stagedComposer .sendButton) { width:28px; height:28px; }
  .stageFooter :deep(.chat-rich-text) { min-height:28px!important; max-height:32px!important; overflow-y:auto; font-size:12px!important; }
  .stageFooter :deep(.chat-placeholder-wrap) { white-space:nowrap; overflow:hidden; text-overflow:ellipsis; font-size:12px; }
}
</style>
