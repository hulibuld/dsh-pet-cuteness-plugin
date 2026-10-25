import test from 'node:test'
import assert from 'node:assert/strict'
import { bucketFromUserMessage, looksLikeQuestion } from '../src/signals.mjs'

/* 信号层的核心风险是**误判**，不是漏判。
   用户没夸她、她突然害羞，比"漏了一次共鸣"尬得多。
   所以这组测试一半是"该命中的命中"，一半是"不该命中的绝不命中"。 */

test('夸奖：谢谢 → praise', () => {
  assert.equal(bucketFromUserMessage('谢谢你'), 'praise')
  assert.equal(bucketFromUserMessage('谢谢啦'), 'praise')
  assert.equal(bucketFromUserMessage('太好了谢谢'), 'praise')
})

test('夸奖：厉害 / 好用 / 不错 → praise', () => {
  assert.equal(bucketFromUserMessage('这个真厉害'), 'praise')
  assert.equal(bucketFromUserMessage('你挺好用的'), 'praise')
  assert.equal(bucketFromUserMessage('不错嘛'), 'praise')
})

test('夸奖：夸聪明 → praise（她的 fear 就在这）', () => {
  assert.equal(bucketFromUserMessage('你比我想的聪明'), 'praise')
  assert.equal(bucketFromUserMessage('比我聪明多了'), 'praise')
})

test('道歉 → headpat（软一点，不是邀功）', () => {
  assert.equal(bucketFromUserMessage('对不起，是我弄错了'), 'headpat')
  assert.equal(bucketFromUserMessage('抱歉抱歉'), 'headpat')
})

test('顺序：道歉优先于夸奖（"对不起，你其实很厉害" 不该被当成夸奖）', () => {
  assert.equal(bucketFromUserMessage('对不起，你其实很厉害'), 'headpat')
})

test('误判防线：贴代码里的"不错"不算夸奖', () => {
  const code = 'const result = x.filter(Boolean); // 这个写法不错\n'.repeat(20)
  assert.equal(bucketFromUserMessage(code), null)
})

test('误判防线：英文/普通叙述不命中', () => {
  assert.equal(bucketFromUserMessage('帮我把这个函数的返回值改成数组'), null)
  assert.equal(bucketFromUserMessage('nice'), null)
  assert.equal(bucketFromUserMessage('hello world'), null)
})

test('误判防线：牛这个字别误伤"牛奶/牛排/牛油"', () => {
  assert.equal(bucketFromUserMessage('帮我查一下牛奶的价格'), null)
  assert.equal(bucketFromUserMessage('牛排怎么做'), null)
  // 但真的在夸就该命中
  assert.equal(bucketFromUserMessage('牛啊'), 'praise')
})

test('空输入不命中', () => {
  assert.equal(bucketFromUserMessage(''), null)
  assert.equal(bucketFromUserMessage('   '), null)
  assert.equal(bucketFromUserMessage(undefined), null)
  assert.equal(bucketFromUserMessage(null), null)
})

test('looksLikeQuestion：问号与疑问词开头', () => {
  assert.equal(looksLikeQuestion('这个怎么改？'), true)
  assert.equal(looksLikeQuestion('为什么报错'), true)
  assert.equal(looksLikeQuestion('能不能帮我看看'), true)
})

test('looksLikeQuestion：陈述句不算提问', () => {
  assert.equal(looksLikeQuestion('我已经改好了。'), false)
  assert.equal(looksLikeQuestion('执行一下这个命令'), false)
  assert.equal(looksLikeQuestion(''), false)
  assert.equal(looksLikeQuestion(undefined), false)
})
