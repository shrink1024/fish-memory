/** A bounded, persisted retry policy. The controller owns model work and storage. */
export const LAZY_DELAYS = [60000, 300000, 1800000];
export function lazyFailure(error) {
    if (error?.dwmCancelled || error?.name === 'AbortError' || error?.dwmYielded) return 'cancelled';
    if (error?.kind === 'capacity') return 'capacity';
    if (error?.dwmStorage) return 'storage';
    if (error?.kind === 'quota') return 'quota';
    if (error?.dwmBlocked) return 'moderation';
    if (error?.dwmResponseInvalid || error?.dwmResponseKind || error?.dwmStreamFault && error.dwmStreamFault !== 'api'
        || /OutputLimit|IncompleteStream/.test(error?.name ?? '')) return 'output';
    if (error?.httpStatus >= 500 || error?.kind === 'timeout' || error?.name === 'TimeoutError'
        || error instanceof TypeError || /network|fetch|timeout|timed out|ECONN|HTTP 5\d\d|网络|超时|断网/i.test(error?.message ?? '')) return 'connection';
    return 'paused';
}
export class LazyAutomation {
    constructor(driver, {now=Date.now,setTimer=setTimeout,clearTimer=clearTimeout,delays=LAZY_DELAYS}={}) {
        // Browsers reject setTimeout called as a method of another object ("Illegal invocation").
        Object.assign(this,{driver,now,delays,setTimer:(fn,ms)=>setTimer(fn,ms),clearTimer:id=>clearTimer(id)});this.epoch=0;this.state={};this.identity=null;this.running=null;this.timer=null;this.task=null;
    }
    stop() { this.epoch++;if(this.timer!==null)this.clearTimer(this.timer);this.timer=null; }
    bind() {
        const id=this.driver.identity();
        if(id!==this.identity){this.stop();this.identity=id;this.state=structuredClone(this.driver.saved()??{});}
    }
    async save(patch, record) {
        const identity=this.identity,epoch=this.epoch;
        const previous=this.state,next={...previous,...patch};
        if(record)next.recent=[...(Array.isArray(record)?record:[record]).map(item=>({...item,at:new Date(this.now()).toISOString()})),...(previous.recent??[])].slice(0,5);
        try {
            await this.driver.save(structuredClone(next));
            if(this.identity!==identity||this.epoch!==epoch)return false;
            this.state=next;this.driver.notify();return true;
        } catch(error){
            if(this.identity!==identity||this.epoch!==epoch)return false;
            // Keep the failed task blocked in memory even if the ledger cannot
            // be saved. Never publish an uncommitted ignore/success record.
            this.state={...previous,failures:next.failures??previous.failures,attention:{reason:error.kind==='capacity'?'capacity':'storage',
                ...(this.task?{task:this.task}:{}),at:new Date(this.now()).toISOString(),error:'自动处理状态未能保存',attempts:0}};
            this.driver.notify();return false;
        }
    }
    schedule() {
        if(this.timer!==null)this.clearTimer(this.timer);this.timer=null;
        if(!this.driver.enabled())return;
        const next=Object.values(this.state.failures??{}).filter(f=>f.nextRetryAt).map(f=>f.nextRetryAt);
        const delay=next.length?Math.max(1000,Math.min(30000,Math.min(...next)-this.now())):30000;
        this.timer=this.setTimer(()=>{this.timer=null;this.kick();},delay);this.timer?.unref?.();
    }
    kick({event=false,force=false}={}) {
        this.bind();
        if(!this.driver.enabled()){this.stop();return Promise.resolve();}
        if(this.running)return this.runEpoch!==this.epoch?this.running.then(()=>this.kick({event,force})):this.running;
        const epoch=this.epoch;this.runEpoch=epoch;
        const current=()=>this.epoch===epoch&&this.driver.enabled()&&this.driver.identity()===this.identity;
        this.running=Promise.resolve().then(async()=>{
            if(!this.driver.idle())return;
            if(this.state.attention?.reason==='storage'){
                if(!force||!await this.save({attention:null}))return;
            }
            const jobs=await this.driver.plan();if(!current()||!this.driver.idle())return;
            const seen=new Set();
            for(const job of jobs){
                if(!current()||!this.driver.idle()||seen.has(job.task))break;seen.add(job.task);
                const failure=this.state.failures?.[job.task];
                const forced=force&&(!this.state.attention?.task||this.state.attention.task===job.task);
                if(failure&&!forced){
                    if(failure.reason==='cancelled'||failure.reason==='paused'||['quota','moderation','capacity','storage'].includes(failure.reason))continue;
                    if(failure.attempts>=5)continue;
                    if(failure.attempts===4&&!event)continue;
                    if(failure.nextRetryAt&&failure.nextRetryAt>this.now())continue;
                }
                this.task=job.task;this.driver.notify();
                const attempt=(failure?.attempts??0)+1;
                try {
                    const result=await this.driver.run(job);
                    if(!current())return;
                    if(result?.executed===false)continue;
                    const failures={...(this.state.failures??{})};delete failures[job.task];
                    const completion=result?.record===null?null:result?.record??{type:job.task,...job.fields};
                    const record=(Array.isArray(completion)?completion:completion?[completion]:[]).map(item=>{
                        const range=item.type==='maintain'?{from:item.from,to:item.to}:failure?.floors;
                        return failure?{type:'retry',attempt:attempt-1,ok:true,task:job.task,
                            ...(range?{floors:{from:range.from,to:range.to}}:{}),completion:item}:item;
                    });
                    if(!await this.save({failures,attention:this.state.attention?.task===job.task?null:this.state.attention,updatedAt:new Date(this.now()).toISOString()},record))break;
                }catch(error){
                    if(!current())return;
                    const reason=lazyFailure(error),floors=error.dwmFloors;
                    const retryable=['connection','output'].includes(reason);
                    const nextRetryAt=retryable&&attempt<=this.delays.length?this.now()+this.delays[attempt-1]:null;
                    const failure={reason,attempts:attempt,nextRetryAt,floors,followUp:error.dwmLazyFollowUp,phase:error.dwmLazyPhase,error:this.driver.errorText(error)};
                    const attention=['quota','moderation','capacity','storage','paused'].includes(reason)||retryable&&attempt>=5
                        ? {reason,task:job.task,at:new Date(this.now()).toISOString(),attempts:attempt-1,error:failure.error,...(floors?{floors:{from:floors.from,to:floors.to}}:{}),...(reason==='moderation'&&floors?.keys?.length?{canIgnore:true}:{}),...(reason==='capacity'?{percent:this.driver.capacity()}: {})} : null;
                    await this.save({failures:{...(this.state.failures??{}),[job.task]:failure},attention:attention??this.state.attention},
                        reason==='moderation'?{type:'moderation',from:floors?.from,to:floors?.to}:failure.attempts>1?{type:'retry',attempt:attempt-1,ok:false,task:job.task,floors:floors?{from:floors.from,to:floors.to}:undefined}:{type:'paused',reason});
                    // Do not continue dependent work after one failed task.
                    break;
                }finally{this.task=null;this.driver.notify();}
            }
        }).catch(error=>{this.driver.diagnostic(error);}).finally(()=>{this.running=null;if(current())this.schedule();});
        return this.running;
    }
}
