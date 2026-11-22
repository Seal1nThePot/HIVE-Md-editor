import SettingRow from './SettingRow';
import {aiResponseTextLimit,type AIResponseDetail,type AIResponseTone,type useAIResponsePreferences} from './useAIResponsePreferences';

export default function AIResponseSettings({preferences,setPreferences,saveError}:ReturnType<typeof useAIResponsePreferences>){
  return <section className="settings-card feature-settings ai-response-settings">
    <h2>AI 回复偏好</h2>
    <SettingRow title="回复详细度">
      <select aria-label="回复详细度" value={preferences.detail} onChange={event=>setPreferences(old=>({...old,detail:event.target.value as AIResponseDetail}))}>
        <option value="concise">简洁</option><option value="detailed">详细</option>
      </select>
    </SettingRow>
    <SettingRow title="回复语气">
      <select aria-label="回复语气" value={preferences.tone} onChange={event=>setPreferences(old=>({...old,tone:event.target.value as AIResponseTone}))}>
        <option value="natural">自然</option><option value="formal">正式</option><option value="friendly">亲切</option>
      </select>
    </SettingRow>
    <SettingRow title="自定义规则" description="例如，多用短句、少用套话。">
      <textarea aria-label="自定义规则" rows={3} maxLength={aiResponseTextLimit} value={preferences.customRules} onChange={event=>setPreferences(old=>({...old,customRules:event.target.value.slice(0,aiResponseTextLimit)}))}/>
    </SettingRow>
    <SettingRow title="人设" description="例如，擅长用例子讲解的写作搭档。">
      <textarea aria-label="人设" rows={3} maxLength={aiResponseTextLimit} value={preferences.persona} onChange={event=>setPreferences(old=>({...old,persona:event.target.value.slice(0,aiResponseTextLimit)}))}/>
    </SettingRow>
    <p>偏好适用于新发起的 AI 写作请求。本轮的任务和写作模式决定输出格式与篇幅限制。</p>
    {saveError&&<p role="status">{saveError}</p>}
  </section>;
}
