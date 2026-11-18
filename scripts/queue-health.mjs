// Aggregate queue health without reading message content or raw error strings.
export function queueHealth(db,{now=Date.now(),notifiedFailures=[],stalledMs=10*60000,rateLimitMs=15*60000}={}) {
 const columns=new Set(db.prepare('PRAGMA table_info(jobs)').all().map(c=>c.name));
 const optional=name=>columns.has(name)?name:`0 AS ${name}`;
 const jobs=db.prepare(`SELECT id,kind,state,attempts,created_at,available_at,${['last_attempt_at','failed_at','retry_after_until','rate_limited_since'].map(optional).join(',')} FROM jobs`).all();
 const notified=new Set(notifiedFailures),failed=jobs.filter(j=>j.state==='failed');
 const key=j=>`${j.id}:${j.failed_at||0}`;
 const newFailures=failed.filter(j=>!notified.has(key(j)));
 let stalled=0,limited=0,retrying=0;
 for(const j of jobs) {
  if(j.state!=='pending')continue;
  if(j.retry_after_until>now) {
   if(j.rate_limited_since && now-j.rate_limited_since>=rateLimitMs)limited++;
   continue;
  }
  if(now-j.created_at<stalledMs)continue;
  if(j.attempts>=5)retrying++;
  else if(now-(j.last_attempt_at||j.created_at)>=stalledMs || now-j.available_at>=stalledMs)stalled++;
 }
 const alerts=[];
 if(stalled)alerts.push(`${stalled} 项任务等待或无进展超过 ${Math.round(stalledMs/60000)} 分钟`);
 if(retrying)alerts.push(`${retrying} 项任务持续重试，请检查客服通道`);
 if(limited)alerts.push(`${limited} 项任务持续限流等待超过 ${Math.round(rateLimitMs/60000)} 分钟`);
 const groups={send:0,attachment:0,auxiliary:0};
 for(const j of newFailures)groups[['outgoing','photo-caption','welcome','topic'].includes(j.kind)?'send':['incoming-file','photo-store'].includes(j.kind)?'attachment':'auxiliary']++;
 return {alerts,newFailureCount:newFailures.length,newFailureSummary:newFailures.length?`新增 ${newFailures.length} 项失败任务（发送 ${groups.send}、附件 ${groups.attachment}、辅助 ${groups.auxiliary}），请检查并处理`:'',failureKeys:failed.map(key),unresolvedFailures:failed.length,stalled,limited,retrying};
}
