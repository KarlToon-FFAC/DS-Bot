// Keep the accepted Windows launcher unchanged; Linux uses an isolated Node supervisor.
import { spawn } from 'node:child_process'
import { join } from 'node:path'
import { runLinuxBench, validateBenchOptions } from './bench-linux.mjs'

const [action='status',name='communication-a',webPort='3101',mockPort='8801']=process.argv.slice(2)
try {
  const options=validateBenchOptions({action,name,webPort:Number(webPort),mockPort:Number(mockPort)})
  if(process.platform==='win32'){
    const child=spawn('powershell.exe',['-NoProfile','-File',join(import.meta.dirname,'bench.ps1'),'-Action',action,'-Name',name,'-WebPort',webPort,'-MockPort',mockPort],{windowsHide:true,stdio:'inherit'})
    child.once('error',()=>{process.stderr.write('WINDOWS_BENCH_START_FAILED\n');process.exitCode=1})
    child.once('exit',code=>{process.exitCode=code??1})
  }else if(process.platform==='linux')await runLinuxBench(options)
  else throw new Error('BENCH_PLATFORM_UNSUPPORTED')
}catch(error){process.stderr.write(/^[A-Z_]+$/.test(error.message)?error.message+'\n':'BENCH_FAILED\n');process.exitCode=1}
