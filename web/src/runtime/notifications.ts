import {api} from '../api';
import {safeNext} from '../app/navigation';
/** Old phone links resolve from persisted evidence; they never restart a rule. */
export async function resolveSignal(signal:string) {
 const result=await api<{domain:string;destination:string|null;event_id?:string}>('/notification-center/resolve?signal='+encodeURIComponent(signal));
 return {...result,destination:result.destination && safeNext(result.destination).startsWith('/advanced-charts')?safeNext(result.destination):null};
}
