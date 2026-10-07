"""Known coverage differences and query plans in the isolated synthetic PG DB."""
import json

from sqlalchemy import BigInteger, or_, select, text

from pg_baseline import ROOT, START, NOW, MINUTE, s, stored_coverage, write_json


def union(spans):
    result=[]
    for a,b in sorted((x['start'],x['end']) for x in spans):
        if b<=a: continue
        if result and a<=result[-1][1]: result[-1][1]=max(b,result[-1][1])
        else: result.append([a,b])
    return result


def difference(a,b):
    result=[]
    for left,right in a:
        cursor=left
        for x,y in b:
            if y<=cursor: continue
            if x>=right: break
            if x>cursor: result.append([cursor,min(x,right)])
            cursor=max(cursor,y)
        if cursor<right: result.append([cursor,right])
    return result


def main():
    cases=[]
    with s.transaction() as db:
        for name, edits, structured in [
            ('dual_write',{},True), ('legacy_no_bounds',{'remove':['range_start','range_end','source']},False),
            ('duplicate',{'duplicate':True},True), ('partial_minute',{'partial':True},False),
            ('wrong_basis',{'basis':'ask'},False), ('wrong_source',{'source':'dukascopy'},False),
            ('malformed_bound',{'range_start':'invalid'},False), ('missing_received',{'remove':['received_at']},False),
        ]:
            ident='COV_'+name
            inst=s.Instrument(id=ident,label=ident,source='oanda',symbol=ident,basis='bid',calendar='ny17',precision=5)
            # Each case rolls back, including malformed inputs, leaving fixture unchanged.
            nested=db.begin_nested()
            try:
                db.add(inst)
                db.flush()
                a=START+(30001 if edits.get('partial') else 0)
                b=START+10*MINUTE+30000
                received=START+8*MINUTE+4000
                details=dict(instrument=ident,source='oanda',basis='bid',received_at=received,
                    range_start=a,range_end=b,ranges=[dict(start=a,end=b)])
                for key,value in edits.items():
                    if key in ('basis','source','range_start'): details[key]=value
                for key in edits.get('remove',[]): details.pop(key)
                db.add(s.Audit(kind='provider_query_coverage',at=NOW,details=details))
                if edits.get('duplicate'): db.add(s.Audit(kind='provider_query_coverage',at=NOW,details=details))
                if structured:
                    db.add(s.MarketCoverage(instrument_id=ident,source='oanda',basis='bid',start=START,end=START+7*MINUTE,queried_at=received))
                old=union(stored_coverage(db,inst,START,START+20*MINUTE))
                new=union([dict(start=r.start,end=r.end) for r in db.scalars(select(s.MarketCoverage).where(s.MarketCoverage.instrument_id==ident,
                    s.MarketCoverage.source==inst.source,s.MarketCoverage.basis==inst.basis))])
                cases.append(dict(case=name,compatibility=old,structured=new,old_minus_new=difference(old,new),new_minus_old=difference(new,old)))
                expected=[] if name=='wrong_basis' else [[START+MINUTE,START+7*MINUTE]] if name=='partial_minute' else [[START,START+7*MINUTE]]
                assert old==expected,(name,old,expected)
            except Exception as error:
                if name not in ('malformed_bound','missing_received'): raise
                cases.append(dict(case=name,error=type(error).__name__,reason='current read cannot isolate malformed audit'))
            finally:
                nested.rollback()
        # Exact SQLAlchemy statement used by compatibility reader, including JSON casts.
        statement=select(s.Audit).where(s.Audit.kind=='provider_query_coverage',s.Audit.details['instrument'].as_string()=='EURUSD',
            or_(s.Audit.details['range_start'].as_string().cast(BigInteger).is_(None),
                (s.Audit.details['range_start'].as_string().cast(BigInteger)<NOW)&(s.Audit.details['range_end'].as_string().cast(BigInteger)>START)))
        compiled=str(statement.compile(s.engine,compile_kwargs={'literal_binds':True}))
        audit_plan=db.execute(text('EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) '+compiled)).scalar()
        statement=select(s.MarketCoverage).where(s.MarketCoverage.instrument_id=='EURUSD',s.MarketCoverage.source=='oanda',
            s.MarketCoverage.basis=='bid',s.MarketCoverage.start<NOW,s.MarketCoverage.end>START)
        structured_plan=db.execute(text('EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) '+str(statement.compile(s.engine,compile_kwargs={'literal_binds':True})))).scalar()
        counts={table.__tablename__:db.scalar(select(text('count(*)')).select_from(table)) for table in (s.Audit,s.Bar,s.ChartPublishedBar)}
    write_json('coverage.json',dict(cases=cases,counts=counts,audit_explain=audit_plan,structured_explain=structured_plan,
        scope='Synthetic isolated DB only; not a migration equivalence proof for existing development or production databases'))
    print(json.dumps(dict(cases=len(cases),counts=counts,audit_ms=audit_plan[0]['Execution Time'],structured_ms=structured_plan[0]['Execution Time'])),flush=True)


if __name__=='__main__': main()
